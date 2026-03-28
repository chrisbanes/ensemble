# Plan 1: Foundation — Project Scaffold, Config, Domain Model, Workspace Manager

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Cargo workspace with `ensemble-core` library crate containing the domain model, WORKFLOW.md config loader, prompt template renderer, and workspace manager — all with comprehensive tests.

**Architecture:** Cargo workspace with a single library crate (`ensemble-core`). The CLI and desktop binaries are not built in this plan — they come in Plans 2 and 3. This plan focuses on the foundational modules that every other component depends on.

**Tech Stack:** Rust (2021 edition), tokio, serde/serde_yaml/serde_json, liquid, notify, tracing, thiserror, chrono, tempfile (tests)

---

## File Structure

```
ensemble/
├── Cargo.toml                          # workspace root
├── crates/
│   └── ensemble-core/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs                  # re-exports public modules
│           ├── error.rs                # EnsembleError, ConfigError, WorkspaceError
│           ├── tracker/
│           │   ├── mod.rs              # IssueTracker trait + re-exports
│           │   └── model.rs            # Issue, BlockerRef, RunningEntry, RetryEntry, etc.
│           ├── config/
│           │   ├── mod.rs              # re-exports
│           │   ├── workflow.rs         # WORKFLOW.md loader (parse front matter + body)
│           │   ├── typed.rs            # ServiceConfig struct with defaults + $VAR resolution
│           │   └── template.rs         # Liquid prompt renderer
│           └── workspace/
│               ├── mod.rs              # re-exports
│               ├── manager.rs          # WorkspaceManager: create, reuse, cleanup, safety
│               └── hooks.rs            # Hook runner with timeouts
```

---

### Task 1: Cargo Workspace Scaffold

**Files:**
- Create: `Cargo.toml` (workspace root — replaces existing empty one)
- Create: `crates/ensemble-core/Cargo.toml`
- Create: `crates/ensemble-core/src/lib.rs`

- [ ] **Step 1: Create workspace root Cargo.toml**

```toml
[workspace]
resolver = "2"
members = ["crates/*"]

[workspace.package]
edition = "2021"
license = "MIT"
rust-version = "1.80"

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
liquid = "0.26"
notify = "7"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }
thiserror = "2"
chrono = { version = "0.4", features = ["serde"] }
tempfile = "3"
async-trait = "0.1"
```

- [ ] **Step 2: Create ensemble-core Cargo.toml**

```toml
[package]
name = "ensemble-core"
version = "0.1.0"
edition.workspace = true
license.workspace = true
rust-version.workspace = true

[dependencies]
tokio = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
serde_yaml = { workspace = true }
liquid = { workspace = true }
notify = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
thiserror = { workspace = true }
chrono = { workspace = true }
async-trait = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
tokio = { workspace = true, features = ["test-util"] }
```

- [ ] **Step 3: Create lib.rs with module declarations**

```rust
pub mod error;
pub mod tracker;
pub mod config;
pub mod workspace;
```

- [ ] **Step 4: Create stub modules so it compiles**

Create these files with minimal content:

`crates/ensemble-core/src/error.rs`:
```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EnsembleError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("missing workflow file: {path}")]
    MissingWorkflowFile { path: String },
    #[error("workflow parse error: {reason}")]
    WorkflowParseError { reason: String },
    #[error("front matter is not a map")]
    FrontMatterNotAMap,
    #[error("template parse error: {reason}")]
    TemplateParseError { reason: String },
    #[error("template render error: {reason}")]
    TemplateRenderError { reason: String },
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace creation failed: {reason}")]
    CreationFailed { reason: String },
    #[error("hook failed: {hook} — {reason}")]
    HookFailed { hook: String, reason: String },
    #[error("hook timed out: {hook} after {timeout_ms}ms")]
    HookTimedOut { hook: String, timeout_ms: u64 },
    #[error("workspace path outside root: {path}")]
    PathOutsideRoot { path: String },
}
```

`crates/ensemble-core/src/tracker/mod.rs`:
```rust
pub mod model;
```

`crates/ensemble-core/src/tracker/model.rs`:
```rust
// Domain model — will be fleshed out in Task 2
```

`crates/ensemble-core/src/config/mod.rs`:
```rust
pub mod workflow;
pub mod typed;
pub mod template;
```

`crates/ensemble-core/src/config/workflow.rs`:
```rust
// WORKFLOW.md loader — will be fleshed out in Task 3
```

`crates/ensemble-core/src/config/typed.rs`:
```rust
// Typed config — will be fleshed out in Task 4
```

`crates/ensemble-core/src/config/template.rs`:
```rust
// Template renderer — will be fleshed out in Task 5
```

`crates/ensemble-core/src/workspace/mod.rs`:
```rust
pub mod manager;
pub mod hooks;
```

`crates/ensemble-core/src/workspace/manager.rs`:
```rust
// Workspace manager — will be fleshed out in Task 6
```

`crates/ensemble-core/src/workspace/hooks.rs`:
```rust
// Hook runner — will be fleshed out in Task 7
```

- [ ] **Step 5: Verify it compiles**

Run: `cargo build`
Expected: Compiles with no errors (may have unused warnings, that's fine)

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/
git commit -m "scaffold: Cargo workspace with ensemble-core library crate"
```

---

### Task 2: Domain Model

**Files:**
- Modify: `crates/ensemble-core/src/tracker/model.rs`

- [ ] **Step 1: Write tests for domain model**

Add to `crates/ensemble-core/src/tracker/model.rs`:

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i32>,
    pub state: String,
    pub branch_name: Option<String>,
    pub url: Option<String>,
    pub labels: Vec<String>,
    pub blocked_by: Vec<BlockerRef>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockerRef {
    pub id: Option<String>,
    pub identifier: Option<String>,
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunningEntry {
    pub issue_id: String,
    pub identifier: String,
    pub issue: Issue,
    pub session_id: Option<String>,
    pub agent_pid: Option<String>,
    pub last_agent_event: Option<String>,
    pub last_agent_timestamp: Option<DateTime<Utc>>,
    pub last_agent_message: Option<String>,
    pub agent_input_tokens: u64,
    pub agent_output_tokens: u64,
    pub agent_total_tokens: u64,
    pub last_reported_input_tokens: u64,
    pub last_reported_output_tokens: u64,
    pub last_reported_total_tokens: u64,
    pub turn_count: u32,
    pub retry_attempt: Option<u32>,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryEntry {
    pub issue_id: String,
    pub identifier: String,
    pub attempt: u32,
    pub due_at_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub seconds_running: f64,
}

/// Sanitize an issue identifier for use as a workspace directory name.
/// Only [A-Za-z0-9._-] are allowed; all other characters become '_'.
pub fn sanitize_workspace_key(identifier: &str) -> String {
    identifier
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_simple_identifier() {
        assert_eq!(sanitize_workspace_key("my-repo_42"), "my-repo_42");
    }

    #[test]
    fn test_sanitize_hash_in_identifier() {
        assert_eq!(sanitize_workspace_key("my-repo#42"), "my-repo_42");
    }

    #[test]
    fn test_sanitize_slashes_and_spaces() {
        assert_eq!(sanitize_workspace_key("acme/repo 123"), "acme_repo_123");
    }

    #[test]
    fn test_sanitize_preserves_dots() {
        assert_eq!(sanitize_workspace_key("v1.2.3-rc1"), "v1.2.3-rc1");
    }

    #[test]
    fn test_sanitize_all_special_chars() {
        assert_eq!(sanitize_workspace_key("a@b!c$d%e"), "a_b_c_d_e");
    }

    #[test]
    fn test_issue_serialization_roundtrip() {
        let issue = Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix the bug".to_string(),
            description: Some("It's broken".to_string()),
            priority: Some(2),
            state: "Todo".to_string(),
            branch_name: None,
            url: Some("https://github.com/acme/repo/issues/42".to_string()),
            labels: vec!["bug".to_string(), "p1".to_string()],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        };
        let json = serde_json::to_string(&issue).unwrap();
        let deserialized: Issue = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, "NODE_123");
        assert_eq!(deserialized.identifier, "my-repo#42");
        assert_eq!(deserialized.labels, vec!["bug", "p1"]);
    }

    #[test]
    fn test_agent_totals_default() {
        let totals = AgentTotals::default();
        assert_eq!(totals.input_tokens, 0);
        assert_eq!(totals.output_tokens, 0);
        assert_eq!(totals.total_tokens, 0);
        assert_eq!(totals.seconds_running, 0.0);
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p ensemble-core`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/tracker/model.rs
git commit -m "feat: add domain model types (Issue, RunningEntry, RetryEntry, AgentTotals)"
```

---

### Task 3: WORKFLOW.md Loader

**Files:**
- Modify: `crates/ensemble-core/src/config/workflow.rs`

- [ ] **Step 1: Write failing tests for workflow loading**

```rust
use crate::error::ConfigError;
use serde_yaml::Value;

/// Parsed workflow file: YAML front matter config + Markdown prompt body.
#[derive(Debug, Clone)]
pub struct WorkflowDefinition {
    /// Parsed YAML front matter as a map. Empty map if no front matter.
    pub config: serde_yaml::Mapping,
    /// Trimmed Markdown body after front matter.
    pub prompt_template: String,
}

/// Load and parse a WORKFLOW.md file from the given path.
pub fn load_workflow(path: &std::path::Path) -> Result<WorkflowDefinition, ConfigError> {
    let content = std::fs::read_to_string(path).map_err(|_| ConfigError::MissingWorkflowFile {
        path: path.display().to_string(),
    })?;
    parse_workflow(&content)
}

/// Parse workflow content (for testing without filesystem).
pub fn parse_workflow(content: &str) -> Result<WorkflowDefinition, ConfigError> {
    if content.starts_with("---") {
        // Find the closing ---
        let rest = &content[3..];
        if let Some(end_idx) = rest.find("\n---") {
            let yaml_str = &rest[..end_idx];
            let body = &rest[end_idx + 4..]; // skip past \n---

            let yaml_value: Value = serde_yaml::from_str(yaml_str).map_err(|e| {
                ConfigError::WorkflowParseError {
                    reason: e.to_string(),
                }
            })?;

            let config = match yaml_value {
                Value::Mapping(m) => m,
                Value::Null => serde_yaml::Mapping::new(),
                _ => return Err(ConfigError::FrontMatterNotAMap),
            };

            Ok(WorkflowDefinition {
                config,
                prompt_template: body.trim().to_string(),
            })
        } else {
            Err(ConfigError::WorkflowParseError {
                reason: "front matter opened with --- but never closed".to_string(),
            })
        }
    } else {
        // No front matter — entire file is prompt body
        Ok(WorkflowDefinition {
            config: serde_yaml::Mapping::new(),
            prompt_template: content.trim().to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_full_workflow() {
        let content = r#"---
tracker:
  kind: github
  repository: acme/repo
polling:
  interval_ms: 15000
---
You are working on {{ issue.identifier }}: {{ issue.title }}
"#;
        let wf = parse_workflow(content).unwrap();
        assert!(wf.config.contains_key("tracker"));
        assert!(wf.config.contains_key("polling"));
        assert_eq!(
            wf.prompt_template,
            "You are working on {{ issue.identifier }}: {{ issue.title }}"
        );
    }

    #[test]
    fn test_parse_no_front_matter() {
        let content = "Just a prompt with no config.";
        let wf = parse_workflow(content).unwrap();
        assert!(wf.config.is_empty());
        assert_eq!(wf.prompt_template, "Just a prompt with no config.");
    }

    #[test]
    fn test_parse_empty_front_matter() {
        let content = "---\n---\nThe prompt body.";
        let wf = parse_workflow(content).unwrap();
        assert!(wf.config.is_empty());
        assert_eq!(wf.prompt_template, "The prompt body.");
    }

    #[test]
    fn test_parse_front_matter_not_a_map() {
        let content = "---\n- item1\n- item2\n---\nBody.";
        let result = parse_workflow(content);
        assert!(matches!(result, Err(ConfigError::FrontMatterNotAMap)));
    }

    #[test]
    fn test_parse_invalid_yaml() {
        let content = "---\n: : : invalid\n---\nBody.";
        let result = parse_workflow(content);
        assert!(matches!(result, Err(ConfigError::WorkflowParseError { .. })));
    }

    #[test]
    fn test_parse_unclosed_front_matter() {
        let content = "---\ntracker:\n  kind: github\nNo closing delimiter";
        let result = parse_workflow(content);
        assert!(matches!(result, Err(ConfigError::WorkflowParseError { .. })));
    }

    #[test]
    fn test_parse_trims_prompt_body() {
        let content = "---\n---\n\n  Indented prompt  \n\n";
        let wf = parse_workflow(content).unwrap();
        assert_eq!(wf.prompt_template, "Indented prompt");
    }

    #[test]
    fn test_load_missing_file() {
        let result = load_workflow(std::path::Path::new("/nonexistent/WORKFLOW.md"));
        assert!(matches!(
            result,
            Err(ConfigError::MissingWorkflowFile { .. })
        ));
    }

    #[test]
    fn test_load_from_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("WORKFLOW.md");
        std::fs::write(
            &path,
            "---\ntracker:\n  kind: github\n---\nDo the work.",
        )
        .unwrap();
        let wf = load_workflow(&path).unwrap();
        assert!(wf.config.contains_key("tracker"));
        assert_eq!(wf.prompt_template, "Do the work.");
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p ensemble-core config::workflow`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/config/workflow.rs
git commit -m "feat: WORKFLOW.md loader with front matter parsing and validation"
```

---

### Task 4: Typed Service Config

**Files:**
- Modify: `crates/ensemble-core/src/config/typed.rs`

- [ ] **Step 1: Write the ServiceConfig struct with defaults and resolution**

```rust
use crate::config::workflow::WorkflowDefinition;
use crate::error::ConfigError;
use serde_yaml::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Typed runtime configuration derived from WORKFLOW.md front matter.
#[derive(Debug, Clone)]
pub struct ServiceConfig {
    // tracker
    pub tracker_kind: Option<String>,
    pub tracker_endpoint: String,
    pub tracker_api_key: Option<String>,
    pub tracker_repository: Option<String>,
    pub tracker_project_number: Option<i64>,
    pub tracker_labels_filter: Vec<String>,
    pub tracker_active_states: Vec<String>,
    pub tracker_terminal_states: Vec<String>,

    // polling
    pub poll_interval_ms: u64,

    // workspace
    pub workspace_root: PathBuf,

    // hooks
    pub hook_after_create: Option<String>,
    pub hook_before_run: Option<String>,
    pub hook_after_run: Option<String>,
    pub hook_before_remove: Option<String>,
    pub hook_timeout_ms: u64,

    // agent
    pub agent_max_concurrent: u32,
    pub agent_max_turns: u32,
    pub agent_max_retry_backoff_ms: u64,
    pub agent_max_concurrent_by_state: HashMap<String, u32>,
    pub agent_command: String,
    pub agent_session_mode: String,
    pub agent_permission_policy: String,
    pub agent_turn_timeout_ms: u64,
    pub agent_read_timeout_ms: u64,
    pub agent_stall_timeout_ms: i64,

    // extensions
    pub server_port: Option<u16>,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            tracker_kind: None,
            tracker_endpoint: "https://api.github.com/graphql".to_string(),
            tracker_api_key: None,
            tracker_repository: None,
            tracker_project_number: None,
            tracker_labels_filter: vec![],
            tracker_active_states: vec!["Todo".to_string(), "In Progress".to_string()],
            tracker_terminal_states: vec!["Done".to_string(), "Closed".to_string()],
            poll_interval_ms: 30_000,
            workspace_root: std::env::temp_dir().join("ensemble_workspaces"),
            hook_after_create: None,
            hook_before_run: None,
            hook_after_run: None,
            hook_before_remove: None,
            hook_timeout_ms: 60_000,
            agent_max_concurrent: 10,
            agent_max_turns: 20,
            agent_max_retry_backoff_ms: 300_000,
            agent_max_concurrent_by_state: HashMap::new(),
            agent_command: "claude-code".to_string(),
            agent_session_mode: "code".to_string(),
            agent_permission_policy: "auto_approve_all".to_string(),
            agent_turn_timeout_ms: 3_600_000,
            agent_read_timeout_ms: 5_000,
            agent_stall_timeout_ms: 300_000,
            server_port: None,
        }
    }
}

/// Resolve `$VAR_NAME` in a string value to its environment variable.
/// Returns the literal string if it doesn't start with `$`.
/// Returns None if the env var is empty or unset.
fn resolve_env_var(value: &str) -> Option<String> {
    if let Some(var_name) = value.strip_prefix('$') {
        match std::env::var(var_name) {
            Ok(v) if !v.is_empty() => Some(v),
            _ => None,
        }
    } else {
        Some(value.to_string())
    }
}

/// Expand `~` to home directory in a path string.
fn expand_tilde(path_str: &str) -> PathBuf {
    if let Some(rest) = path_str.strip_prefix('~') {
        if let Some(home) = dirs_next().or_else(|| std::env::var("HOME").ok()) {
            return PathBuf::from(home).join(rest.strip_prefix('/').unwrap_or(rest));
        }
    }
    PathBuf::from(path_str)
}

fn dirs_next() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME").ok()
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::env::var("HOME").ok()
    }
}

/// Extract a string value from a YAML mapping at the given key path.
fn yaml_string(mapping: &serde_yaml::Mapping, section: &str, key: &str) -> Option<String> {
    mapping
        .get(section)?
        .as_mapping()?
        .get(key)?
        .as_str()
        .map(|s| s.to_string())
}

/// Extract an integer value from a YAML mapping, accepting both integers and string integers.
fn yaml_int(mapping: &serde_yaml::Mapping, section: &str, key: &str) -> Option<i64> {
    let section_map = mapping.get(section)?.as_mapping()?;
    let val = section_map.get(key)?;
    val.as_i64()
        .or_else(|| val.as_str().and_then(|s| s.parse::<i64>().ok()))
}

/// Extract a list of strings from a YAML mapping.
fn yaml_string_list(
    mapping: &serde_yaml::Mapping,
    section: &str,
    key: &str,
) -> Option<Vec<String>> {
    mapping
        .get(section)?
        .as_mapping()?
        .get(key)?
        .as_sequence()
        .map(|seq| {
            seq.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
}

impl ServiceConfig {
    /// Build a ServiceConfig from a parsed WorkflowDefinition.
    pub fn from_workflow(workflow: &WorkflowDefinition) -> Result<Self, ConfigError> {
        let m = &workflow.config;
        let mut config = ServiceConfig::default();

        // tracker
        if let Some(kind) = yaml_string(m, "tracker", "kind") {
            config.tracker_kind = Some(kind);
        }
        if let Some(endpoint) = yaml_string(m, "tracker", "endpoint") {
            config.tracker_endpoint = endpoint;
        }
        if let Some(api_key_raw) = yaml_string(m, "tracker", "api_key") {
            config.tracker_api_key = resolve_env_var(&api_key_raw);
        } else {
            // Try canonical env var
            config.tracker_api_key = resolve_env_var("$GITHUB_TOKEN");
        }
        if let Some(repo) = yaml_string(m, "tracker", "repository") {
            config.tracker_repository = Some(repo);
        }
        if let Some(pn) = yaml_int(m, "tracker", "project_number") {
            config.tracker_project_number = Some(pn);
        }
        if let Some(labels) = yaml_string_list(m, "tracker", "labels_filter") {
            config.tracker_labels_filter = labels;
        }
        if let Some(states) = yaml_string_list(m, "tracker", "active_states") {
            config.tracker_active_states = states;
        }
        if let Some(states) = yaml_string_list(m, "tracker", "terminal_states") {
            config.tracker_terminal_states = states;
        }

        // polling
        if let Some(ms) = yaml_int(m, "polling", "interval_ms") {
            config.poll_interval_ms = ms as u64;
        }

        // workspace
        if let Some(root_str) = yaml_string(m, "workspace", "root") {
            let resolved = resolve_env_var(&root_str).unwrap_or(root_str.clone());
            config.workspace_root = expand_tilde(&resolved);
        }

        // hooks
        if let Some(script) = yaml_string(m, "hooks", "after_create") {
            config.hook_after_create = Some(script);
        }
        if let Some(script) = yaml_string(m, "hooks", "before_run") {
            config.hook_before_run = Some(script);
        }
        if let Some(script) = yaml_string(m, "hooks", "after_run") {
            config.hook_after_run = Some(script);
        }
        if let Some(script) = yaml_string(m, "hooks", "before_remove") {
            config.hook_before_remove = Some(script);
        }
        if let Some(ms) = yaml_int(m, "hooks", "timeout_ms") {
            if ms > 0 {
                config.hook_timeout_ms = ms as u64;
            }
        }

        // agent
        if let Some(n) = yaml_int(m, "agent", "max_concurrent_agents") {
            config.agent_max_concurrent = n as u32;
        }
        if let Some(n) = yaml_int(m, "agent", "max_turns") {
            config.agent_max_turns = n as u32;
        }
        if let Some(ms) = yaml_int(m, "agent", "max_retry_backoff_ms") {
            config.agent_max_retry_backoff_ms = ms as u64;
        }
        if let Some(cmd) = yaml_string(m, "agent", "command") {
            config.agent_command = cmd;
        }
        if let Some(mode) = yaml_string(m, "agent", "session_mode") {
            config.agent_session_mode = mode;
        }
        if let Some(policy) = yaml_string(m, "agent", "permission_policy") {
            config.agent_permission_policy = policy;
        }
        if let Some(ms) = yaml_int(m, "agent", "turn_timeout_ms") {
            config.agent_turn_timeout_ms = ms as u64;
        }
        if let Some(ms) = yaml_int(m, "agent", "read_timeout_ms") {
            config.agent_read_timeout_ms = ms as u64;
        }
        if let Some(ms) = yaml_int(m, "agent", "stall_timeout_ms") {
            config.agent_stall_timeout_ms = ms;
        }

        // per-state concurrency
        if let Some(section) = m.get("agent") {
            if let Some(by_state) = section.as_mapping().and_then(|m| m.get("max_concurrent_agents_by_state")) {
                if let Some(state_map) = by_state.as_mapping() {
                    for (k, v) in state_map {
                        if let (Some(state_name), Some(limit)) = (
                            k.as_str(),
                            v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())),
                        ) {
                            if limit > 0 {
                                config
                                    .agent_max_concurrent_by_state
                                    .insert(state_name.to_lowercase(), limit as u32);
                            }
                        }
                    }
                }
            }
        }

        // extensions
        if let Some(port) = yaml_int(m, "server", "port") {
            config.server_port = Some(port as u16);
        }

        Ok(config)
    }

    /// Validate the config has everything needed for dispatch.
    pub fn validate_for_dispatch(&self) -> Result<(), ConfigError> {
        if self.tracker_kind.is_none() {
            return Err(ConfigError::WorkflowParseError {
                reason: "tracker.kind is required".to_string(),
            });
        }
        let kind = self.tracker_kind.as_deref().unwrap();
        if kind != "github" {
            return Err(ConfigError::WorkflowParseError {
                reason: format!("unsupported tracker.kind: {kind}"),
            });
        }
        if self.tracker_api_key.is_none() {
            return Err(ConfigError::WorkflowParseError {
                reason: "tracker.api_key is required (or set GITHUB_TOKEN env)".to_string(),
            });
        }
        if self.tracker_repository.is_none() {
            return Err(ConfigError::WorkflowParseError {
                reason: "tracker.repository is required when tracker.kind=github".to_string(),
            });
        }
        if self.agent_command.is_empty() {
            return Err(ConfigError::WorkflowParseError {
                reason: "agent.command must be non-empty".to_string(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::workflow::parse_workflow;

    fn config_from_yaml(yaml: &str) -> ServiceConfig {
        let content = format!("---\n{yaml}\n---\nPrompt body.");
        let wf = parse_workflow(&content).unwrap();
        ServiceConfig::from_workflow(&wf).unwrap()
    }

    #[test]
    fn test_defaults() {
        let config = ServiceConfig::default();
        assert_eq!(config.poll_interval_ms, 30_000);
        assert_eq!(config.agent_max_concurrent, 10);
        assert_eq!(config.agent_max_turns, 20);
        assert_eq!(config.agent_turn_timeout_ms, 3_600_000);
        assert_eq!(config.agent_read_timeout_ms, 5_000);
        assert_eq!(config.agent_stall_timeout_ms, 300_000);
        assert_eq!(config.hook_timeout_ms, 60_000);
        assert_eq!(
            config.tracker_active_states,
            vec!["Todo", "In Progress"]
        );
        assert_eq!(
            config.tracker_terminal_states,
            vec!["Done", "Closed"]
        );
    }

    #[test]
    fn test_from_workflow_overrides_defaults() {
        let config = config_from_yaml(
            r#"
tracker:
  kind: github
  repository: acme/repo
polling:
  interval_ms: 10000
agent:
  max_concurrent_agents: 5
  command: my-agent
"#,
        );
        assert_eq!(config.tracker_kind.as_deref(), Some("github"));
        assert_eq!(config.tracker_repository.as_deref(), Some("acme/repo"));
        assert_eq!(config.poll_interval_ms, 10_000);
        assert_eq!(config.agent_max_concurrent, 5);
        assert_eq!(config.agent_command, "my-agent");
    }

    #[test]
    fn test_string_integer_coercion() {
        let config = config_from_yaml(
            r#"
polling:
  interval_ms: "15000"
agent:
  max_concurrent_agents: "3"
"#,
        );
        assert_eq!(config.poll_interval_ms, 15_000);
        assert_eq!(config.agent_max_concurrent, 3);
    }

    #[test]
    fn test_per_state_concurrency() {
        let config = config_from_yaml(
            r#"
agent:
  max_concurrent_agents_by_state:
    todo: 2
    In Progress: 5
"#,
        );
        assert_eq!(config.agent_max_concurrent_by_state.get("todo"), Some(&2));
        assert_eq!(
            config.agent_max_concurrent_by_state.get("in progress"),
            Some(&5)
        );
    }

    #[test]
    fn test_per_state_ignores_invalid() {
        let config = config_from_yaml(
            r#"
agent:
  max_concurrent_agents_by_state:
    todo: -1
    good: 3
"#,
        );
        assert_eq!(config.agent_max_concurrent_by_state.get("todo"), None);
        assert_eq!(config.agent_max_concurrent_by_state.get("good"), Some(&3));
    }

    #[test]
    fn test_hook_timeout_non_positive_uses_default() {
        let config = config_from_yaml(
            r#"
hooks:
  timeout_ms: 0
"#,
        );
        assert_eq!(config.hook_timeout_ms, 60_000);
    }

    #[test]
    fn test_env_var_resolution() {
        std::env::set_var("ENSEMBLE_TEST_KEY", "secret123");
        let config = config_from_yaml(
            r#"
tracker:
  api_key: $ENSEMBLE_TEST_KEY
"#,
        );
        assert_eq!(config.tracker_api_key.as_deref(), Some("secret123"));
        std::env::remove_var("ENSEMBLE_TEST_KEY");
    }

    #[test]
    fn test_env_var_empty_treated_as_missing() {
        std::env::set_var("ENSEMBLE_EMPTY_KEY", "");
        let config = config_from_yaml(
            r#"
tracker:
  api_key: $ENSEMBLE_EMPTY_KEY
"#,
        );
        assert_eq!(config.tracker_api_key, None);
        std::env::remove_var("ENSEMBLE_EMPTY_KEY");
    }

    #[test]
    fn test_tilde_expansion() {
        let config = config_from_yaml(
            r#"
workspace:
  root: ~/my_workspaces
"#,
        );
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            config.workspace_root,
            PathBuf::from(home).join("my_workspaces")
        );
    }

    #[test]
    fn test_validate_missing_tracker_kind() {
        let config = ServiceConfig::default();
        let result = config.validate_for_dispatch();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_unsupported_tracker_kind() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("linear".to_string());
        let result = config.validate_for_dispatch();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_missing_api_key() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_repository = Some("acme/repo".to_string());
        let result = config.validate_for_dispatch();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_missing_repository() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = Some("ghp_xxx".to_string());
        let result = config.validate_for_dispatch();
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_success() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = Some("ghp_xxx".to_string());
        config.tracker_repository = Some("acme/repo".to_string());
        assert!(config.validate_for_dispatch().is_ok());
    }

    #[test]
    fn test_labels_filter() {
        let config = config_from_yaml(
            r#"
tracker:
  labels_filter:
    - agent-ready
    - auto-fix
"#,
        );
        assert_eq!(
            config.tracker_labels_filter,
            vec!["agent-ready", "auto-fix"]
        );
    }

    #[test]
    fn test_server_port() {
        let config = config_from_yaml(
            r#"
server:
  port: 8080
"#,
        );
        assert_eq!(config.server_port, Some(8080));
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p ensemble-core config::typed`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/config/typed.rs
git commit -m "feat: typed ServiceConfig with defaults, env var resolution, and validation"
```

---

### Task 5: Prompt Template Renderer

**Files:**
- Modify: `crates/ensemble-core/src/config/template.rs`

- [ ] **Step 1: Write the template renderer with tests**

```rust
use crate::error::ConfigError;
use crate::tracker::model::Issue;
use liquid::ParserBuilder;

/// Render a Liquid prompt template with the given issue and attempt.
///
/// Uses strict mode: unknown variables and filters cause errors.
pub fn render_prompt(
    template_str: &str,
    issue: &Issue,
    attempt: Option<u32>,
) -> Result<String, ConfigError> {
    let parser = ParserBuilder::with_stdlib()
        .build()
        .map_err(|e| ConfigError::TemplateParseError {
            reason: e.to_string(),
        })?;

    let template = parser
        .parse(template_str)
        .map_err(|e| ConfigError::TemplateParseError {
            reason: e.to_string(),
        })?;

    // Build the issue object for Liquid
    let issue_obj = liquid::object!({
        "id": issue.id,
        "identifier": issue.identifier,
        "title": issue.title,
        "description": issue.description.as_deref().unwrap_or(""),
        "priority": issue.priority,
        "state": issue.state,
        "branch_name": issue.branch_name.as_deref().unwrap_or(""),
        "url": issue.url.as_deref().unwrap_or(""),
        "labels": issue.labels,
    });

    let mut globals = liquid::object!({
        "issue": issue_obj,
    });

    if let Some(a) = attempt {
        globals.insert("attempt".into(), liquid::model::Value::scalar(a as i64));
    }

    template
        .render(&globals)
        .map_err(|e| ConfigError::TemplateRenderError {
            reason: e.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_issue() -> Issue {
        Issue {
            id: "NODE_123".to_string(),
            identifier: "my-repo#42".to_string(),
            title: "Fix login bug".to_string(),
            description: Some("The login page crashes".to_string()),
            priority: Some(1),
            state: "Todo".to_string(),
            branch_name: None,
            url: Some("https://github.com/acme/repo/issues/42".to_string()),
            labels: vec!["bug".to_string(), "p1".to_string()],
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn test_render_simple_template() {
        let template = "Work on {{ issue.identifier }}: {{ issue.title }}";
        let result = render_prompt(template, &test_issue(), None).unwrap();
        assert_eq!(result, "Work on my-repo#42: Fix login bug");
    }

    #[test]
    fn test_render_with_attempt() {
        let template = "{% if attempt %}Retry attempt {{ attempt }}. {% endif %}Work on {{ issue.identifier }}.";
        let result = render_prompt(template, &test_issue(), Some(2)).unwrap();
        assert_eq!(result, "Retry attempt 2. Work on my-repo#42.");
    }

    #[test]
    fn test_render_no_attempt_is_absent() {
        let template = "{% if attempt %}retry{% else %}first run{% endif %}";
        let result = render_prompt(template, &test_issue(), None).unwrap();
        assert_eq!(result, "first run");
    }

    #[test]
    fn test_render_labels() {
        let template = "Labels: {% for label in issue.labels %}{{ label }} {% endfor %}";
        let result = render_prompt(template, &test_issue(), None).unwrap();
        assert_eq!(result, "Labels: bug p1 ");
    }

    #[test]
    fn test_render_description() {
        let template = "{{ issue.description }}";
        let result = render_prompt(template, &test_issue(), None).unwrap();
        assert_eq!(result, "The login page crashes");
    }

    #[test]
    fn test_render_empty_template() {
        let result = render_prompt("", &test_issue(), None).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_render_invalid_syntax() {
        let result = render_prompt("{{ unclosed", &test_issue(), None);
        assert!(matches!(result, Err(ConfigError::TemplateParseError { .. })));
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p ensemble-core config::template`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/config/template.rs
git commit -m "feat: Liquid prompt template renderer with strict variable checking"
```

---

### Task 6: Workspace Manager

**Files:**
- Modify: `crates/ensemble-core/src/workspace/manager.rs`

- [ ] **Step 1: Write the workspace manager with tests**

```rust
use crate::error::WorkspaceError;
use crate::tracker::model::sanitize_workspace_key;
use std::path::{Path, PathBuf};

/// Result of preparing a workspace for an issue.
pub struct WorkspaceResult {
    /// Absolute path to the workspace directory.
    pub path: PathBuf,
    /// The sanitized workspace key used as the directory name.
    pub workspace_key: String,
    /// True if the directory was newly created (not reused).
    pub created_now: bool,
}

/// Manage per-issue workspace directories.
pub struct WorkspaceManager {
    root: PathBuf,
}

impl WorkspaceManager {
    /// Create a new WorkspaceManager with the given workspace root.
    /// The root is normalized to an absolute path.
    pub fn new(root: &Path) -> Result<Self, WorkspaceError> {
        let root = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| WorkspaceError::CreationFailed {
                    reason: format!("cannot resolve relative root: {e}"),
                })?
                .join(root)
        };
        Ok(Self { root })
    }

    /// Get the absolute workspace root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Prepare (create or reuse) a workspace for the given issue identifier.
    pub fn prepare_workspace(&self, identifier: &str) -> Result<WorkspaceResult, WorkspaceError> {
        let workspace_key = sanitize_workspace_key(identifier);
        let workspace_path = self.root.join(&workspace_key);

        // Safety: ensure workspace path is inside root
        self.validate_path_inside_root(&workspace_path)?;

        let created_now = if workspace_path.exists() {
            if !workspace_path.is_dir() {
                return Err(WorkspaceError::CreationFailed {
                    reason: format!(
                        "path exists but is not a directory: {}",
                        workspace_path.display()
                    ),
                });
            }
            false
        } else {
            std::fs::create_dir_all(&workspace_path).map_err(|e| {
                WorkspaceError::CreationFailed {
                    reason: format!("mkdir failed: {e}"),
                }
            })?;
            true
        };

        Ok(WorkspaceResult {
            path: workspace_path,
            workspace_key,
            created_now,
        })
    }

    /// Remove a workspace directory for the given issue identifier.
    pub fn remove_workspace(&self, identifier: &str) -> Result<(), WorkspaceError> {
        let workspace_key = sanitize_workspace_key(identifier);
        let workspace_path = self.root.join(&workspace_key);

        self.validate_path_inside_root(&workspace_path)?;

        if workspace_path.exists() {
            std::fs::remove_dir_all(&workspace_path).map_err(|e| {
                WorkspaceError::CreationFailed {
                    reason: format!("remove failed: {e}"),
                }
            })?;
        }
        Ok(())
    }

    /// Validate that a workspace path is inside the workspace root.
    fn validate_path_inside_root(&self, path: &Path) -> Result<(), WorkspaceError> {
        // Canonicalize root if it exists, otherwise use as-is
        let abs_root = if self.root.exists() {
            self.root.canonicalize().unwrap_or_else(|_| self.root.clone())
        } else {
            self.root.clone()
        };

        let abs_path = if path.exists() {
            path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
        } else {
            path.to_path_buf()
        };

        if !abs_path.starts_with(&abs_root) {
            return Err(WorkspaceError::PathOutsideRoot {
                path: abs_path.display().to_string(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, WorkspaceManager) {
        let dir = TempDir::new().unwrap();
        let mgr = WorkspaceManager::new(dir.path()).unwrap();
        (dir, mgr)
    }

    #[test]
    fn test_prepare_creates_new_workspace() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("my-repo#42").unwrap();
        assert!(result.created_now);
        assert_eq!(result.workspace_key, "my-repo_42");
        assert!(result.path.is_dir());
    }

    #[test]
    fn test_prepare_reuses_existing_workspace() {
        let (_dir, mgr) = setup();
        let first = mgr.prepare_workspace("my-repo#42").unwrap();
        assert!(first.created_now);

        let second = mgr.prepare_workspace("my-repo#42").unwrap();
        assert!(!second.created_now);
        assert_eq!(first.path, second.path);
    }

    #[test]
    fn test_prepare_sanitizes_identifier() {
        let (_dir, mgr) = setup();
        let result = mgr.prepare_workspace("acme/repo 123!@#").unwrap();
        assert_eq!(result.workspace_key, "acme_repo_123___");
        assert!(result.path.is_dir());
    }

    #[test]
    fn test_prepare_deterministic_path() {
        let (_dir, mgr) = setup();
        let r1 = mgr.prepare_workspace("test-issue").unwrap();
        let r2 = mgr.prepare_workspace("test-issue").unwrap();
        assert_eq!(r1.path, r2.path);
    }

    #[test]
    fn test_remove_workspace() {
        let (_dir, mgr) = setup();
        mgr.prepare_workspace("my-repo#42").unwrap();

        let ws_path = mgr.root().join("my-repo_42");
        assert!(ws_path.exists());

        mgr.remove_workspace("my-repo#42").unwrap();
        assert!(!ws_path.exists());
    }

    #[test]
    fn test_remove_nonexistent_is_ok() {
        let (_dir, mgr) = setup();
        assert!(mgr.remove_workspace("nonexistent").is_ok());
    }

    #[test]
    fn test_path_inside_root_validation() {
        let (_dir, mgr) = setup();
        // Normal path should be fine
        let result = mgr.prepare_workspace("normal-issue");
        assert!(result.is_ok());
    }

    #[test]
    fn test_file_at_workspace_path_errors() {
        let (dir, mgr) = setup();
        // Create a file where the workspace dir would be
        let file_path = dir.path().join("my-repo_42");
        std::fs::write(&file_path, "not a directory").unwrap();

        let result = mgr.prepare_workspace("my-repo#42");
        assert!(matches!(result, Err(WorkspaceError::CreationFailed { .. })));
    }

    #[test]
    fn test_workspace_root_accessor() {
        let (dir, mgr) = setup();
        assert_eq!(mgr.root(), dir.path());
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p ensemble-core workspace::manager`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/workspace/manager.rs
git commit -m "feat: workspace manager with create, reuse, cleanup, and safety invariants"
```

---

### Task 7: Workspace Hook Runner

**Files:**
- Modify: `crates/ensemble-core/src/workspace/hooks.rs`

- [ ] **Step 1: Write the hook runner with tests**

```rust
use crate::error::WorkspaceError;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{info, warn};

/// Run a shell hook script in the given workspace directory with a timeout.
///
/// The script is executed via `sh -lc <script>` with cwd set to `workspace_path`.
/// Returns Ok(()) on success, Err on failure or timeout.
pub async fn run_hook(
    hook_name: &str,
    script: &str,
    workspace_path: &Path,
    timeout_ms: u64,
) -> Result<(), WorkspaceError> {
    info!(hook = hook_name, cwd = %workspace_path.display(), "running hook");

    let duration = Duration::from_millis(timeout_ms);

    let result = timeout(duration, async {
        Command::new("sh")
            .arg("-lc")
            .arg(script)
            .current_dir(workspace_path)
            .output()
            .await
    })
    .await;

    match result {
        Ok(Ok(output)) => {
            if output.status.success() {
                info!(hook = hook_name, "hook completed successfully");
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let reason = if stderr.is_empty() {
                    format!("exit code: {}", output.status)
                } else {
                    // Truncate stderr for logging
                    let truncated: String = stderr.chars().take(500).collect();
                    format!("exit code: {} — {}", output.status, truncated)
                };
                warn!(hook = hook_name, %reason, "hook failed");
                Err(WorkspaceError::HookFailed {
                    hook: hook_name.to_string(),
                    reason,
                })
            }
        }
        Ok(Err(e)) => {
            let reason = format!("failed to execute: {e}");
            warn!(hook = hook_name, %reason, "hook execution error");
            Err(WorkspaceError::HookFailed {
                hook: hook_name.to_string(),
                reason,
            })
        }
        Err(_) => {
            warn!(hook = hook_name, timeout_ms, "hook timed out");
            Err(WorkspaceError::HookTimedOut {
                hook: hook_name.to_string(),
                timeout_ms,
            })
        }
    }
}

/// Run a hook if configured; swallow errors for non-fatal hooks.
/// Returns Ok(()) always — errors are logged but not propagated.
pub async fn run_hook_best_effort(
    hook_name: &str,
    script: &str,
    workspace_path: &Path,
    timeout_ms: u64,
) {
    if let Err(e) = run_hook(hook_name, script, workspace_path, timeout_ms).await {
        warn!(hook = hook_name, error = %e, "non-fatal hook error (ignored)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        TempDir::new().unwrap()
    }

    #[tokio::test]
    async fn test_hook_success() {
        let dir = setup();
        let result = run_hook("test_hook", "true", dir.path(), 5000).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_hook_failure() {
        let dir = setup();
        let result = run_hook("test_hook", "false", dir.path(), 5000).await;
        assert!(matches!(result, Err(WorkspaceError::HookFailed { .. })));
    }

    #[tokio::test]
    async fn test_hook_with_stderr() {
        let dir = setup();
        let result =
            run_hook("test_hook", "echo 'oh no' >&2; exit 1", dir.path(), 5000).await;
        match result {
            Err(WorkspaceError::HookFailed { reason, .. }) => {
                assert!(reason.contains("oh no"));
            }
            _ => panic!("expected HookFailed"),
        }
    }

    #[tokio::test]
    async fn test_hook_timeout() {
        let dir = setup();
        let result = run_hook("test_hook", "sleep 10", dir.path(), 100).await;
        assert!(matches!(result, Err(WorkspaceError::HookTimedOut { .. })));
    }

    #[tokio::test]
    async fn test_hook_uses_workspace_cwd() {
        let dir = setup();
        // Create a marker file, then verify hook can see it
        std::fs::write(dir.path().join("marker.txt"), "hello").unwrap();
        let result = run_hook("test_hook", "test -f marker.txt", dir.path(), 5000).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_hook_best_effort_swallows_errors() {
        let dir = setup();
        // This should not panic or return an error
        run_hook_best_effort("test_hook", "false", dir.path(), 5000).await;
    }

    #[tokio::test]
    async fn test_hook_multiline_script() {
        let dir = setup();
        let script = "echo 'line1'\necho 'line2'\ntrue";
        let result = run_hook("test_hook", script, dir.path(), 5000).await;
        assert!(result.is_ok());
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p ensemble-core workspace::hooks`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/workspace/hooks.rs
git commit -m "feat: workspace hook runner with timeout enforcement and best-effort mode"
```

---

### Task 8: IssueTracker Trait + Integration Wiring

**Files:**
- Modify: `crates/ensemble-core/src/tracker/mod.rs`
- Modify: `crates/ensemble-core/src/lib.rs`

- [ ] **Step 1: Define the IssueTracker trait**

Update `crates/ensemble-core/src/tracker/mod.rs`:

```rust
pub mod model;

use async_trait::async_trait;
use model::Issue;

/// Error type for tracker operations.
#[derive(Debug, thiserror::Error)]
pub enum TrackerError {
    #[error("unsupported tracker kind: {kind}")]
    UnsupportedKind { kind: String },
    #[error("missing tracker API key")]
    MissingApiKey,
    #[error("missing tracker repository")]
    MissingRepository,
    #[error("GitHub API request failed: {reason}")]
    ApiRequestFailed { reason: String },
    #[error("GitHub API returned status {status}: {body}")]
    ApiStatus { status: u16, body: String },
    #[error("GitHub GraphQL errors: {errors}")]
    GraphqlErrors { errors: String },
    #[error("unexpected payload: {reason}")]
    UnexpectedPayload { reason: String },
    #[error("pagination error: missing end cursor")]
    MissingEndCursor,
}

/// Trait for issue tracker adapters.
/// The orchestrator uses this to fetch issues without knowing the tracker backend.
#[async_trait]
pub trait IssueTracker: Send + Sync {
    /// Fetch candidate issues in active states for dispatch.
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError>;

    /// Fetch issues in the given states (used for startup terminal cleanup).
    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError>;

    /// Fetch current states for specific issue IDs (used for reconciliation).
    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError>;
}
```

- [ ] **Step 2: Update error.rs to include TrackerError in EnsembleError**

Update `crates/ensemble-core/src/error.rs` to add:

```rust
use crate::tracker::TrackerError;
```

And add to the `EnsembleError` enum:

```rust
#[error(transparent)]
Tracker(#[from] TrackerError),
```

- [ ] **Step 3: Verify everything compiles and all tests pass**

Run: `cargo test -p ensemble-core`
Expected: All tests pass, no compilation errors

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/tracker/mod.rs crates/ensemble-core/src/error.rs
git commit -m "feat: IssueTracker trait with TrackerError types"
```

---

### Task 9: End-to-End Integration Test

**Files:**
- Create: `crates/ensemble-core/tests/workflow_to_workspace.rs`

This test verifies the full flow from loading a WORKFLOW.md through config parsing to workspace creation.

- [ ] **Step 1: Write the integration test**

```rust
//! Integration test: load WORKFLOW.md -> parse config -> create workspace -> run hooks

use ensemble_core::config::template::render_prompt;
use ensemble_core::config::typed::ServiceConfig;
use ensemble_core::config::workflow::load_workflow;
use ensemble_core::tracker::model::{sanitize_workspace_key, Issue};
use ensemble_core::workspace::hooks::run_hook;
use ensemble_core::workspace::manager::WorkspaceManager;
use tempfile::TempDir;

fn sample_issue() -> Issue {
    Issue {
        id: "NODE_ABC".to_string(),
        identifier: "test-repo#7".to_string(),
        title: "Add dark mode".to_string(),
        description: Some("Users want dark mode".to_string()),
        priority: Some(2),
        state: "Todo".to_string(),
        branch_name: None,
        url: Some("https://github.com/acme/test-repo/issues/7".to_string()),
        labels: vec!["enhancement".to_string()],
        blocked_by: vec![],
        created_at: None,
        updated_at: None,
    }
}

#[test]
fn test_full_config_flow() {
    let dir = TempDir::new().unwrap();
    let workflow_path = dir.path().join("WORKFLOW.md");
    let ws_root = dir.path().join("workspaces");

    std::fs::write(
        &workflow_path,
        format!(
            r#"---
tracker:
  kind: github
  repository: acme/test-repo
  api_key: fake-token
workspace:
  root: {}
agent:
  command: echo hello
  max_concurrent_agents: 3
hooks:
  after_create: echo "workspace created"
---
You are working on {{{{ issue.identifier }}}}: {{{{ issue.title }}}}

Description: {{{{ issue.description }}}}

{{% if attempt %}}This is retry attempt {{{{ attempt }}}}.{{% endif %}}
"#,
            ws_root.display()
        ),
    )
    .unwrap();

    // 1. Load workflow
    let workflow = load_workflow(&workflow_path).unwrap();
    assert!(!workflow.prompt_template.is_empty());

    // 2. Parse config
    let config = ServiceConfig::from_workflow(&workflow).unwrap();
    assert_eq!(config.tracker_kind.as_deref(), Some("github"));
    assert_eq!(config.tracker_repository.as_deref(), Some("acme/test-repo"));
    assert_eq!(config.agent_max_concurrent, 3);
    assert_eq!(config.workspace_root, ws_root);

    // 3. Validate for dispatch
    assert!(config.validate_for_dispatch().is_ok());

    // 4. Render prompt
    let issue = sample_issue();
    let prompt = render_prompt(&workflow.prompt_template, &issue, None).unwrap();
    assert!(prompt.contains("test-repo#7"));
    assert!(prompt.contains("Add dark mode"));
    assert!(prompt.contains("Users want dark mode"));
    assert!(!prompt.contains("retry attempt"));

    // Render with retry
    let retry_prompt = render_prompt(&workflow.prompt_template, &issue, Some(2)).unwrap();
    assert!(retry_prompt.contains("retry attempt 2"));

    // 5. Create workspace
    let mgr = WorkspaceManager::new(&config.workspace_root).unwrap();
    let ws = mgr.prepare_workspace(&issue.identifier).unwrap();
    assert!(ws.created_now);
    assert!(ws.path.is_dir());
    assert_eq!(ws.workspace_key, sanitize_workspace_key(&issue.identifier));

    // 6. Reuse workspace
    let ws2 = mgr.prepare_workspace(&issue.identifier).unwrap();
    assert!(!ws2.created_now);
    assert_eq!(ws.path, ws2.path);

    // 7. Cleanup
    mgr.remove_workspace(&issue.identifier).unwrap();
    assert!(!ws.path.exists());
}

#[tokio::test]
async fn test_hook_in_workspace() {
    let dir = TempDir::new().unwrap();
    let mgr = WorkspaceManager::new(dir.path()).unwrap();
    let ws = mgr.prepare_workspace("hook-test#1").unwrap();

    // Run a hook that creates a file
    run_hook(
        "after_create",
        "echo 'initialized' > .ensemble-init",
        &ws.path,
        5000,
    )
    .await
    .unwrap();

    let marker = ws.path.join(".ensemble-init");
    assert!(marker.exists());
    let content = std::fs::read_to_string(&marker).unwrap();
    assert_eq!(content.trim(), "initialized");
}
```

- [ ] **Step 2: Run the integration test**

Run: `cargo test -p ensemble-core --test workflow_to_workspace`
Expected: All tests pass

- [ ] **Step 3: Run all tests one final time**

Run: `cargo test -p ensemble-core`
Expected: All tests pass (unit + integration)

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/tests/workflow_to_workspace.rs
git commit -m "test: end-to-end integration test for config -> workspace flow"
```

---

## Summary

After completing all 9 tasks, you'll have:

- A Cargo workspace with `ensemble-core` library crate
- Domain model types matching SPEC.md Section 4 (`Issue`, `RunningEntry`, `RetryEntry`, `AgentTotals`)
- WORKFLOW.md loader with YAML front matter parsing (Section 5.1-5.2)
- Typed `ServiceConfig` with all fields from Section 5.3, defaults, `$VAR` resolution, `~` expansion, dispatch validation (Section 6.3)
- Liquid prompt template renderer with strict mode (Section 5.4)
- Workspace manager with create/reuse/cleanup and all three safety invariants (Section 9)
- Hook runner with timeout enforcement and correct failure semantics (Section 9.4)
- `IssueTracker` trait ready for the GitHub implementation in Plan 2
- Integration test proving the full config-to-workspace flow

**Next:** Plan 2 will add the GitHub tracker client, ACP agent client, orchestrator state machine, HTTP API, and CLI binary.
