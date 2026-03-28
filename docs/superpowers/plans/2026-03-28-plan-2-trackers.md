# Plan 2: Trackers — TODO File + GitHub Projects

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the two built-in tracker backends (TODO file and GitHub Projects v2) that provide normalized issue data to the orchestrator.

**Architecture:** Both trackers implement the `IssueTracker` trait defined in Plan 1. A factory function in `tracker/mod.rs` creates the correct tracker from `ServiceConfig`. The TODO file tracker reads a local Markdown file; the GitHub tracker uses `reqwest` for GraphQL queries against the GitHub Projects v2 API. The orchestrator never knows which backend it's using.

**Tech Stack:** Rust (2021 edition), reqwest (with json feature), wiremock (tests), tempfile (tests), async-trait, serde_json, chrono

---

## File Structure

```
ensemble/
├── Cargo.toml                          # workspace root (add reqwest, wiremock)
├── crates/
│   └── ensemble-core/
│       ├── Cargo.toml                  # add reqwest, wiremock
│       └── src/
│           └── tracker/
│               ├── mod.rs              # add create_tracker factory + tests
│               ├── model.rs            # (from Plan 1, unchanged)
│               ├── todo_file.rs        # NEW: TodoFileTracker
│               └── github.rs           # NEW: GithubTracker
│       └── tests/
│           └── tracker_integration.rs  # NEW: end-to-end tracker factory test
```

---

### Task 1: Add reqwest + wiremock Dependencies

**Files:**
- Modify: `Cargo.toml` (workspace root)
- Modify: `crates/ensemble-core/Cargo.toml`

- [ ] **Step 1: Add reqwest and wiremock to workspace root Cargo.toml**

Add the following entries to the `[workspace.dependencies]` section in the workspace root `Cargo.toml`:

```toml
reqwest = { version = "0.12", features = ["json"] }
wiremock = "0.6"
```

The full `[workspace.dependencies]` section should now look like this (showing only the additions — keep all existing entries from Plan 1):

```toml
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
reqwest = { version = "0.12", features = ["json"] }
wiremock = "0.6"
```

- [ ] **Step 2: Add reqwest and wiremock to ensemble-core Cargo.toml**

Add `reqwest` to `[dependencies]` and `wiremock` to `[dev-dependencies]` in `crates/ensemble-core/Cargo.toml`:

```toml
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
reqwest = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
tokio = { workspace = true, features = ["test-util"] }
wiremock = { workspace = true }
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p ensemble-core`
Expected: Compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml crates/ensemble-core/Cargo.toml
git commit -m "deps: add reqwest (json) and wiremock to workspace"
```

---

### Task 2: TODO.md File Tracker (`todo_file.rs`)

**Files:**
- Create: `crates/ensemble-core/src/tracker/todo_file.rs`
- Modify: `crates/ensemble-core/src/tracker/mod.rs` (add `pub mod todo_file;`)

- [ ] **Step 1: Register the module**

Add `pub mod todo_file;` to `crates/ensemble-core/src/tracker/mod.rs`. The file should now start with:

```rust
pub mod model;
pub mod todo_file;
```

(Keep all existing trait/error code from Plan 1 unchanged.)

- [ ] **Step 2: Write the TodoFileTracker implementation with tests**

Create `crates/ensemble-core/src/tracker/todo_file.rs`:

```rust
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use tracing::warn;

use super::model::Issue;
use super::{IssueTracker, TrackerError};

/// Issue tracker backed by a local Markdown file.
///
/// File format:
/// ```markdown
/// ## Todo
/// - [PROJ-1] Add login page
///   Description here.
/// - [PROJ-2] Fix checkout bug
///
/// ## In Progress
/// - [PROJ-3] Refactor auth
///
/// ## Done
/// - [PROJ-4] Set up CI
/// ```
pub struct TodoFileTracker {
    path: PathBuf,
    active_states: Vec<String>,
}

impl TodoFileTracker {
    /// Create a new TodoFileTracker.
    ///
    /// * `path` — path to the TODO.md file
    /// * `active_states` — state headings that are considered active for dispatch
    pub fn new(path: PathBuf, active_states: Vec<String>) -> Self {
        Self {
            path,
            active_states,
        }
    }

    /// Read and parse the TODO file, returning all issues across all state sections.
    fn parse_file(&self) -> Result<Vec<ParsedIssue>, TrackerError> {
        let content = match std::fs::read_to_string(&self.path) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                warn!(path = %self.path.display(), "TODO file not found, returning empty list");
                return Ok(vec![]);
            }
            Err(e) => {
                return Err(TrackerError::ApiRequestFailed {
                    reason: format!("failed to read {}: {}", self.path.display(), e),
                });
            }
        };
        Ok(parse_todo_content(&content))
    }
}

/// An issue parsed from the TODO file, before normalization to the Issue model.
#[derive(Debug, Clone)]
struct ParsedIssue {
    identifier: String,
    title: String,
    description: Option<String>,
    state: String,
    priority: i32,
}

/// Parse the content of a TODO.md file into a list of ParsedIssues.
///
/// Parsing rules:
/// - Level-2 headings (`## <State>`) define state sections.
/// - Lines starting with `- ` under a heading are issues.
/// - `[IDENTIFIER]` at start of title extracts the identifier.
/// - Indented continuation lines after the title form the description.
/// - Priority = position within the state section (0 = highest).
fn parse_todo_content(content: &str) -> Vec<ParsedIssue> {
    let mut issues = Vec::new();
    let mut current_state: Option<String> = None;
    let mut position_in_state: i32 = 0;

    // Track current issue being built (for multi-line descriptions)
    let mut current_issue: Option<ParsedIssue> = None;
    let mut current_desc_lines: Vec<String> = Vec::new();

    for line in content.lines() {
        // Check for heading
        if let Some(heading) = line.strip_prefix("## ") {
            // Flush current issue if any
            if let Some(mut issue) = current_issue.take() {
                if !current_desc_lines.is_empty() {
                    issue.description = Some(current_desc_lines.join("\n").trim().to_string());
                    current_desc_lines.clear();
                }
                issues.push(issue);
            }

            let heading = heading.trim();
            if !heading.is_empty() {
                current_state = Some(heading.to_string());
                position_in_state = 0;
            }
            continue;
        }

        // Check for list item
        if let Some(rest) = line.strip_prefix("- ") {
            // Flush current issue if any
            if let Some(mut issue) = current_issue.take() {
                if !current_desc_lines.is_empty() {
                    issue.description = Some(current_desc_lines.join("\n").trim().to_string());
                    current_desc_lines.clear();
                }
                issues.push(issue);
            }

            if let Some(state) = &current_state {
                let rest = rest.trim();
                let (identifier, title) = extract_identifier_and_title(rest);

                current_issue = Some(ParsedIssue {
                    identifier,
                    title,
                    description: None,
                    state: state.clone(),
                    priority: position_in_state,
                });
                position_in_state += 1;
            }
            continue;
        }

        // Check for description continuation (indented line under current issue)
        if current_issue.is_some() {
            let trimmed = line.trim();
            if !trimmed.is_empty() && (line.starts_with("  ") || line.starts_with('\t')) {
                current_desc_lines.push(trimmed.to_string());
            } else if trimmed.is_empty() {
                // Blank line within description — preserve it if we already have desc lines
                if !current_desc_lines.is_empty() {
                    current_desc_lines.push(String::new());
                }
            }
        }
    }

    // Flush final issue
    if let Some(mut issue) = current_issue.take() {
        if !current_desc_lines.is_empty() {
            issue.description = Some(current_desc_lines.join("\n").trim().to_string());
        }
        issues.push(issue);
    }

    issues
}

/// Extract identifier and title from a list item.
///
/// If the line starts with `[IDENTIFIER]`, extracts the identifier and remaining title.
/// Otherwise generates a stable slug from the title.
fn extract_identifier_and_title(line: &str) -> (String, String) {
    if line.starts_with('[') {
        if let Some(end) = line.find(']') {
            let identifier = line[1..end].to_string();
            let title = line[end + 1..].trim().to_string();
            if !identifier.is_empty() {
                return (identifier, title);
            }
        }
    }
    // No bracketed identifier — generate a stable slug
    let slug = generate_slug(line);
    (slug, line.to_string())
}

/// Generate a stable slug identifier from a title string.
///
/// Lowercases, replaces non-alphanumeric chars with hyphens, collapses
/// consecutive hyphens, and trims leading/trailing hyphens.
fn generate_slug(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Collapse consecutive hyphens
    let mut result = String::new();
    let mut prev_hyphen = false;
    for c in slug.chars() {
        if c == '-' {
            if !prev_hyphen {
                result.push(c);
            }
            prev_hyphen = true;
        } else {
            result.push(c);
            prev_hyphen = false;
        }
    }

    // Trim leading/trailing hyphens
    result.trim_matches('-').to_string()
}

/// Convert a ParsedIssue into the normalized Issue model.
fn to_issue(parsed: &ParsedIssue) -> Issue {
    Issue {
        id: parsed.identifier.clone(),
        identifier: parsed.identifier.clone(),
        title: parsed.title.clone(),
        description: parsed.description.clone(),
        priority: Some(parsed.priority),
        state: parsed.state.clone(),
        branch_name: None,
        url: None,
        labels: vec![],
        blocked_by: vec![],
        created_at: None,
        updated_at: None,
    }
}

/// Check if a state matches any in a list (case-insensitive).
fn state_matches(state: &str, states: &[String]) -> bool {
    states
        .iter()
        .any(|s| s.eq_ignore_ascii_case(state))
}

#[async_trait]
impl IssueTracker for TodoFileTracker {
    /// Fetch candidate issues in active states for dispatch.
    ///
    /// Reads the file, parses all issues, returns those in active states.
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        let parsed = self.parse_file()?;
        let issues = parsed
            .iter()
            .filter(|p| state_matches(&p.state, &self.active_states))
            .map(to_issue)
            .collect();
        Ok(issues)
    }

    /// Fetch issues in the given states.
    ///
    /// Reads the file, returns issues whose state matches any in the provided list.
    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        let parsed = self.parse_file()?;
        let issues = parsed
            .iter()
            .filter(|p| state_matches(&p.state, states))
            .map(to_issue)
            .collect();
        Ok(issues)
    }

    /// Fetch current states for specific issue IDs.
    ///
    /// Reads the file, returns issues whose identifier matches any in the provided list.
    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        let parsed = self.parse_file()?;
        let issues = parsed
            .iter()
            .filter(|p| ids.iter().any(|id| id == &p.identifier))
            .map(to_issue)
            .collect();
        Ok(issues)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_todo(dir: &Path, content: &str) -> PathBuf {
        let path = dir.join("TODO.md");
        std::fs::write(&path, content).unwrap();
        path
    }

    fn active_states() -> Vec<String> {
        vec!["Todo".to_string(), "In Progress".to_string()]
    }

    // --- parse_todo_content tests ---

    #[test]
    fn test_parse_basic_file() {
        let content = r#"## Todo
- [PROJ-1] Add login page
  Description here.
- [PROJ-2] Fix checkout bug

## In Progress
- [PROJ-3] Refactor auth

## Done
- [PROJ-4] Set up CI
"#;
        let issues = parse_todo_content(content);
        assert_eq!(issues.len(), 4);

        assert_eq!(issues[0].identifier, "PROJ-1");
        assert_eq!(issues[0].title, "Add login page");
        assert_eq!(issues[0].description.as_deref(), Some("Description here."));
        assert_eq!(issues[0].state, "Todo");
        assert_eq!(issues[0].priority, 0);

        assert_eq!(issues[1].identifier, "PROJ-2");
        assert_eq!(issues[1].title, "Fix checkout bug");
        assert_eq!(issues[1].description, None);
        assert_eq!(issues[1].state, "Todo");
        assert_eq!(issues[1].priority, 1);

        assert_eq!(issues[2].identifier, "PROJ-3");
        assert_eq!(issues[2].title, "Refactor auth");
        assert_eq!(issues[2].state, "In Progress");
        assert_eq!(issues[2].priority, 0);

        assert_eq!(issues[3].identifier, "PROJ-4");
        assert_eq!(issues[3].title, "Set up CI");
        assert_eq!(issues[3].state, "Done");
        assert_eq!(issues[3].priority, 0);
    }

    #[test]
    fn test_parse_no_identifier_generates_slug() {
        let content = "## Todo\n- Add login page\n- Fix the checkout bug!\n";
        let issues = parse_todo_content(content);
        assert_eq!(issues.len(), 2);

        assert_eq!(issues[0].identifier, "add-login-page");
        assert_eq!(issues[0].title, "Add login page");

        assert_eq!(issues[1].identifier, "fix-the-checkout-bug");
        assert_eq!(issues[1].title, "Fix the checkout bug!");
    }

    #[test]
    fn test_parse_multiline_description() {
        let content = r#"## Todo
- [PROJ-1] Add login page
  First line of description.
  Second line of description.
"#;
        let issues = parse_todo_content(content);
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].description.as_deref(),
            Some("First line of description.\nSecond line of description.")
        );
    }

    #[test]
    fn test_parse_empty_file() {
        let issues = parse_todo_content("");
        assert_eq!(issues.len(), 0);
    }

    #[test]
    fn test_parse_no_headings() {
        let content = "- [PROJ-1] Orphan item\n";
        let issues = parse_todo_content(content);
        // Items without a heading section are ignored
        assert_eq!(issues.len(), 0);
    }

    #[test]
    fn test_parse_empty_heading_ignored() {
        let content = "## \n- [PROJ-1] Item under empty heading\n";
        let issues = parse_todo_content(content);
        assert_eq!(issues.len(), 0);
    }

    #[test]
    fn test_parse_priority_is_position_within_state() {
        let content = r#"## Todo
- [A] First
- [B] Second
- [C] Third

## In Progress
- [D] First in progress
- [E] Second in progress
"#;
        let issues = parse_todo_content(content);
        assert_eq!(issues[0].priority, 0); // A
        assert_eq!(issues[1].priority, 1); // B
        assert_eq!(issues[2].priority, 2); // C
        assert_eq!(issues[3].priority, 0); // D — resets for new state
        assert_eq!(issues[4].priority, 1); // E
    }

    #[test]
    fn test_parse_empty_bracket_generates_slug() {
        let content = "## Todo\n- [] Some title\n";
        let issues = parse_todo_content(content);
        assert_eq!(issues.len(), 1);
        // Empty brackets -> fallback to slug
        assert_eq!(issues[0].identifier, "some-title");
        assert_eq!(issues[0].title, "[] Some title");
    }

    // --- extract_identifier_and_title tests ---

    #[test]
    fn test_extract_with_identifier() {
        let (id, title) = extract_identifier_and_title("[PROJ-1] Add login page");
        assert_eq!(id, "PROJ-1");
        assert_eq!(title, "Add login page");
    }

    #[test]
    fn test_extract_without_identifier() {
        let (id, title) = extract_identifier_and_title("Add login page");
        assert_eq!(id, "add-login-page");
        assert_eq!(title, "Add login page");
    }

    #[test]
    fn test_extract_identifier_with_hash() {
        let (id, title) = extract_identifier_and_title("[my-repo#42] Fix bug");
        assert_eq!(id, "my-repo#42");
        assert_eq!(title, "Fix bug");
    }

    // --- generate_slug tests ---

    #[test]
    fn test_slug_basic() {
        assert_eq!(generate_slug("Add login page"), "add-login-page");
    }

    #[test]
    fn test_slug_special_chars() {
        assert_eq!(
            generate_slug("Fix the bug! (urgent)"),
            "fix-the-bug-urgent"
        );
    }

    #[test]
    fn test_slug_consecutive_special() {
        assert_eq!(generate_slug("a---b___c"), "a-b-c");
    }

    #[test]
    fn test_slug_leading_trailing() {
        assert_eq!(generate_slug("--hello--"), "hello");
    }

    // --- state_matches tests ---

    #[test]
    fn test_state_matches_case_insensitive() {
        let states = vec!["Todo".to_string(), "In Progress".to_string()];
        assert!(state_matches("todo", &states));
        assert!(state_matches("TODO", &states));
        assert!(state_matches("Todo", &states));
        assert!(state_matches("in progress", &states));
        assert!(state_matches("In Progress", &states));
        assert!(!state_matches("Done", &states));
    }

    // --- IssueTracker impl tests (async) ---

    #[tokio::test]
    async fn test_fetch_candidates_returns_active_states_only() {
        let dir = TempDir::new().unwrap();
        let content = r#"## Todo
- [PROJ-1] First task
- [PROJ-2] Second task

## In Progress
- [PROJ-3] Active task

## Done
- [PROJ-4] Finished task
"#;
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path, active_states());

        let issues = tracker.fetch_candidate_issues().await.unwrap();
        assert_eq!(issues.len(), 3);
        assert_eq!(issues[0].identifier, "PROJ-1");
        assert_eq!(issues[1].identifier, "PROJ-2");
        assert_eq!(issues[2].identifier, "PROJ-3");
    }

    #[tokio::test]
    async fn test_fetch_candidates_empty_file() {
        let dir = TempDir::new().unwrap();
        let path = write_todo(dir.path(), "");
        let tracker = TodoFileTracker::new(path, active_states());

        let issues = tracker.fetch_candidate_issues().await.unwrap();
        assert_eq!(issues.len(), 0);
    }

    #[tokio::test]
    async fn test_fetch_candidates_missing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("NONEXISTENT.md");
        let tracker = TodoFileTracker::new(path, active_states());

        // Missing file returns empty list, not an error
        let issues = tracker.fetch_candidate_issues().await.unwrap();
        assert_eq!(issues.len(), 0);
    }

    #[tokio::test]
    async fn test_fetch_by_states() {
        let dir = TempDir::new().unwrap();
        let content = r#"## Todo
- [PROJ-1] Task one

## In Progress
- [PROJ-2] Task two

## Done
- [PROJ-3] Task three

## Blocked
- [PROJ-4] Task four
"#;
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path, active_states());

        let done_issues = tracker
            .fetch_issues_by_states(&["Done".to_string()])
            .await
            .unwrap();
        assert_eq!(done_issues.len(), 1);
        assert_eq!(done_issues[0].identifier, "PROJ-3");

        let multiple = tracker
            .fetch_issues_by_states(&["Todo".to_string(), "Blocked".to_string()])
            .await
            .unwrap();
        assert_eq!(multiple.len(), 2);
        assert_eq!(multiple[0].identifier, "PROJ-1");
        assert_eq!(multiple[1].identifier, "PROJ-4");
    }

    #[tokio::test]
    async fn test_fetch_by_states_case_insensitive() {
        let dir = TempDir::new().unwrap();
        let content = "## Todo\n- [A] Task\n";
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path, active_states());

        let issues = tracker
            .fetch_issues_by_states(&["todo".to_string()])
            .await
            .unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].identifier, "A");
    }

    #[tokio::test]
    async fn test_fetch_states_by_ids() {
        let dir = TempDir::new().unwrap();
        let content = r#"## Todo
- [PROJ-1] First
- [PROJ-2] Second

## Done
- [PROJ-3] Third
"#;
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path, active_states());

        let issues = tracker
            .fetch_issue_states_by_ids(&["PROJ-1".to_string(), "PROJ-3".to_string()])
            .await
            .unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].identifier, "PROJ-1");
        assert_eq!(issues[0].state, "Todo");
        assert_eq!(issues[1].identifier, "PROJ-3");
        assert_eq!(issues[1].state, "Done");
    }

    #[tokio::test]
    async fn test_fetch_states_by_ids_not_found() {
        let dir = TempDir::new().unwrap();
        let content = "## Todo\n- [PROJ-1] First\n";
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path, active_states());

        let issues = tracker
            .fetch_issue_states_by_ids(&["NONEXISTENT".to_string()])
            .await
            .unwrap();
        assert_eq!(issues.len(), 0);
    }

    #[tokio::test]
    async fn test_issue_normalization() {
        let dir = TempDir::new().unwrap();
        let content = "## Todo\n- [PROJ-1] Add login\n  A description.\n";
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path, active_states());

        let issues = tracker.fetch_candidate_issues().await.unwrap();
        assert_eq!(issues.len(), 1);

        let issue = &issues[0];
        assert_eq!(issue.id, "PROJ-1");
        assert_eq!(issue.identifier, "PROJ-1");
        assert_eq!(issue.title, "Add login");
        assert_eq!(issue.description.as_deref(), Some("A description."));
        assert_eq!(issue.priority, Some(0));
        assert_eq!(issue.state, "Todo");
        assert!(issue.branch_name.is_none());
        assert!(issue.url.is_none());
        assert!(issue.labels.is_empty());
        assert!(issue.blocked_by.is_empty());
        assert!(issue.created_at.is_none());
        assert!(issue.updated_at.is_none());
    }
}
```

- [ ] **Step 3: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core tracker::todo_file`
Expected: All tests pass (approximately 20 tests)

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/src/tracker/todo_file.rs crates/ensemble-core/src/tracker/mod.rs
git commit -m "feat: TodoFileTracker — file-based issue tracker with markdown parsing"
```

---

### Task 3: Tracker Factory Function

**Files:**
- Modify: `crates/ensemble-core/src/tracker/mod.rs`

- [ ] **Step 1: Add the factory function and tests to `tracker/mod.rs`**

Update `crates/ensemble-core/src/tracker/mod.rs` to contain the full contents below. This preserves all existing code from Plan 1 (the trait, error types) and adds the `create_tracker` factory plus its module declarations:

```rust
pub mod model;
pub mod todo_file;
pub mod github;

use async_trait::async_trait;
use model::Issue;
use crate::config::typed::ServiceConfig;

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

/// Create an `IssueTracker` implementation based on the service config.
///
/// Matches on `tracker_kind` to return the right backend:
/// - `"todo_file"` -> `TodoFileTracker`
/// - `"github"` -> `GithubTracker`
///
/// Returns an error if the tracker kind is missing or unsupported, or
/// if required configuration is absent (e.g., missing API key for GitHub).
pub fn create_tracker(config: &ServiceConfig) -> Result<Box<dyn IssueTracker>, TrackerError> {
    let kind = config
        .tracker_kind
        .as_deref()
        .ok_or_else(|| TrackerError::UnsupportedKind {
            kind: "<none>".to_string(),
        })?;

    match kind {
        "todo_file" => {
            let tracker = todo_file::TodoFileTracker::new(
                config.tracker_path.clone(),
                config.tracker_active_states.clone(),
            );
            Ok(Box::new(tracker))
        }
        "github" => {
            let token = config
                .tracker_api_key
                .as_ref()
                .ok_or(TrackerError::MissingApiKey)?;
            let repository = config
                .tracker_repository
                .as_ref()
                .ok_or(TrackerError::MissingRepository)?;

            let tracker = github::GithubTracker::new(
                config.tracker_endpoint.clone(),
                token.clone(),
                repository.clone(),
                config.tracker_project_number,
                config.tracker_active_states.clone(),
                config.tracker_terminal_states.clone(),
                config.tracker_labels_filter.clone(),
            )?;
            Ok(Box::new(tracker))
        }
        other => Err(TrackerError::UnsupportedKind {
            kind: other.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::typed::ServiceConfig;
    use tempfile::TempDir;

    #[test]
    fn test_create_todo_file_tracker() {
        let dir = TempDir::new().unwrap();
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("todo_file".to_string());
        config.tracker_path = dir.path().join("TODO.md");

        let tracker = create_tracker(&config);
        assert!(tracker.is_ok());
    }

    #[test]
    fn test_create_github_tracker() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = Some("ghp_test_token".to_string());
        config.tracker_repository = Some("acme/repo".to_string());

        let tracker = create_tracker(&config);
        assert!(tracker.is_ok());
    }

    #[test]
    fn test_create_github_tracker_missing_api_key() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = None;
        config.tracker_repository = Some("acme/repo".to_string());

        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::MissingApiKey)));
    }

    #[test]
    fn test_create_github_tracker_missing_repository() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("github".to_string());
        config.tracker_api_key = Some("ghp_test_token".to_string());
        config.tracker_repository = None;

        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::MissingRepository)));
    }

    #[test]
    fn test_create_unsupported_kind() {
        let mut config = ServiceConfig::default();
        config.tracker_kind = Some("linear".to_string());

        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::UnsupportedKind { .. })));
    }

    #[test]
    fn test_create_no_kind() {
        let config = ServiceConfig::default();
        // tracker_kind is None by default
        let result = create_tracker(&config);
        assert!(matches!(result, Err(TrackerError::UnsupportedKind { .. })));
    }
}
```

- [ ] **Step 2: Verify it compiles**

Note: This step will NOT compile yet because `github.rs` does not exist. Create a stub `crates/ensemble-core/src/tracker/github.rs` to satisfy the module declaration:

```rust
use async_trait::async_trait;

use super::model::Issue;
use super::{IssueTracker, TrackerError};

/// GitHub Projects v2 issue tracker using GraphQL.
pub struct GithubTracker {
    endpoint: String,
    token: String,
    owner: String,
    repo: String,
    project_number: Option<i64>,
    active_states: Vec<String>,
    terminal_states: Vec<String>,
    labels_filter: Vec<String>,
    client: reqwest::Client,
}

impl GithubTracker {
    /// Create a new GithubTracker.
    ///
    /// Parses `owner/repo` from the repository string.
    /// The reqwest client is created with a 30-second timeout.
    pub fn new(
        endpoint: String,
        token: String,
        repository: String,
        project_number: Option<i64>,
        active_states: Vec<String>,
        terminal_states: Vec<String>,
        labels_filter: Vec<String>,
    ) -> Result<Self, TrackerError> {
        let (owner, repo) = parse_owner_repo(&repository)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| TrackerError::ApiRequestFailed {
                reason: format!("failed to build HTTP client: {e}"),
            })?;

        Ok(Self {
            endpoint,
            token,
            owner,
            repo,
            project_number,
            active_states,
            terminal_states,
            labels_filter,
            client,
        })
    }
}

/// Parse "owner/repo" into (owner, repo).
fn parse_owner_repo(repository: &str) -> Result<(String, String), TrackerError> {
    let parts: Vec<&str> = repository.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(TrackerError::UnexpectedPayload {
            reason: format!("invalid repository format '{}', expected 'owner/repo'", repository),
        });
    }
    Ok((parts[0].to_string(), parts[1].to_string()))
}

#[async_trait]
impl IssueTracker for GithubTracker {
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        todo!("Implemented in Task 4")
    }

    async fn fetch_issues_by_states(&self, _states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        todo!("Implemented in Task 4")
    }

    async fn fetch_issue_states_by_ids(&self, _ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        todo!("Implemented in Task 4")
    }
}
```

Run: `cargo test -p ensemble-core tracker::tests`
Expected: All 6 factory tests pass

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/tracker/mod.rs crates/ensemble-core/src/tracker/github.rs
git commit -m "feat: tracker factory function with GitHub stub for compilation"
```

---

### Task 4: GitHub Projects v2 Tracker (`github.rs`)

**Files:**
- Modify: `crates/ensemble-core/src/tracker/github.rs` (replace stub with full implementation)

- [ ] **Step 1: Write the full GithubTracker implementation with tests**

Replace the entire contents of `crates/ensemble-core/src/tracker/github.rs`:

```rust
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use super::model::{BlockerRef, Issue};
use super::{IssueTracker, TrackerError};

// --- GraphQL query constants ---

/// Discovery query: resolve Project v2 node ID and Status field ID.
const PROJECT_DISCOVERY_QUERY: &str = r#"
query($owner: String!, $repo: String!, $projectNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    projectV2(number: $projectNumber) {
      id
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
            }
          }
        }
      }
    }
  }
}
"#;

/// Fetch project items with pagination.
const PROJECT_ITEMS_QUERY: &str = r#"
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 50, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2SingleSelectField {
                    name
                  }
                }
              }
            }
          }
          content {
            ... on Issue {
              id
              number
              title
              body
              createdAt
              updatedAt
              url
              labels(first: 20) {
                nodes {
                  name
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

/// Fetch repository issues (no project board).
const REPO_ISSUES_QUERY: &str = r#"
query($owner: String!, $repo: String!, $cursor: String, $labels: [String!]) {
  repository(owner: $owner, name: $repo) {
    issues(first: 50, after: $cursor, states: [OPEN], labels: $labels, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        number
        title
        body
        createdAt
        updatedAt
        url
        state
        labels(first: 20) {
          nodes {
            name
          }
        }
      }
    }
  }
}
"#;

/// Batch query for issue states by node IDs.
const ISSUE_STATES_QUERY: &str = r#"
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Issue {
      id
      number
      title
      state
      url
      labels(first: 20) {
        nodes {
          name
        }
      }
      projectItems(first: 10) {
        nodes {
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2SingleSelectField {
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

/// GitHub Projects v2 issue tracker using GraphQL.
pub struct GithubTracker {
    endpoint: String,
    token: String,
    owner: String,
    repo: String,
    project_number: Option<i64>,
    active_states: Vec<String>,
    terminal_states: Vec<String>,
    labels_filter: Vec<String>,
    client: reqwest::Client,
    /// Cached project node ID (resolved at first use when project_number is set).
    project_node_id: tokio::sync::RwLock<Option<String>>,
    /// Cached Status field ID.
    status_field_id: tokio::sync::RwLock<Option<String>>,
}

impl GithubTracker {
    /// Create a new GithubTracker.
    ///
    /// Parses `owner/repo` from the repository string.
    /// The reqwest client is created with a 30-second timeout.
    pub fn new(
        endpoint: String,
        token: String,
        repository: String,
        project_number: Option<i64>,
        active_states: Vec<String>,
        terminal_states: Vec<String>,
        labels_filter: Vec<String>,
    ) -> Result<Self, TrackerError> {
        let (owner, repo) = parse_owner_repo(&repository)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| TrackerError::ApiRequestFailed {
                reason: format!("failed to build HTTP client: {e}"),
            })?;

        Ok(Self {
            endpoint,
            token,
            owner,
            repo,
            project_number,
            active_states,
            terminal_states,
            labels_filter,
            client,
            project_node_id: tokio::sync::RwLock::new(None),
            status_field_id: tokio::sync::RwLock::new(None),
        })
    }

    /// Execute a GraphQL query against the configured endpoint.
    async fn graphql(&self, query: &str, variables: Value) -> Result<Value, TrackerError> {
        let body = json!({
            "query": query,
            "variables": variables,
        });

        debug!(endpoint = %self.endpoint, "sending GraphQL request");

        let response = self
            .client
            .post(&self.endpoint)
            .header("Authorization", format!("bearer {}", self.token))
            .header("User-Agent", "ensemble-core")
            .json(&body)
            .send()
            .await
            .map_err(|e| TrackerError::ApiRequestFailed {
                reason: e.to_string(),
            })?;

        // Track rate limit
        if let Some(remaining) = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
        {
            if remaining < 500 {
                warn!(remaining, "GitHub API rate limit running low");
            } else {
                debug!(remaining, "GitHub API rate limit remaining");
            }
        }

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(TrackerError::ApiStatus {
                status: status.as_u16(),
                body: body_text,
            });
        }

        let json_body: Value = response.json().await.map_err(|e| {
            TrackerError::UnexpectedPayload {
                reason: format!("failed to parse response JSON: {e}"),
            }
        })?;

        // Check for GraphQL errors
        if let Some(errors) = json_body.get("errors") {
            if let Some(arr) = errors.as_array() {
                if !arr.is_empty() {
                    let messages: Vec<String> = arr
                        .iter()
                        .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                        .map(|s| s.to_string())
                        .collect();
                    return Err(TrackerError::GraphqlErrors {
                        errors: messages.join("; "),
                    });
                }
            }
        }

        json_body.get("data").cloned().ok_or_else(|| {
            TrackerError::UnexpectedPayload {
                reason: "response missing 'data' field".to_string(),
            }
        })
    }

    /// Discover the project node ID and status field ID via GraphQL.
    /// Caches results for subsequent calls.
    async fn ensure_project_metadata(&self) -> Result<(String, String), TrackerError> {
        // Check cache first
        {
            let node_id = self.project_node_id.read().await;
            let field_id = self.status_field_id.read().await;
            if let (Some(nid), Some(fid)) = (node_id.as_ref(), field_id.as_ref()) {
                return Ok((nid.clone(), fid.clone()));
            }
        }

        let project_number = self.project_number.ok_or_else(|| {
            TrackerError::UnexpectedPayload {
                reason: "project_number is required for project board mode".to_string(),
            }
        })?;

        info!(
            owner = %self.owner,
            repo = %self.repo,
            project_number,
            "discovering project metadata"
        );

        let variables = json!({
            "owner": self.owner,
            "repo": self.repo,
            "projectNumber": project_number,
        });

        let data = self.graphql(PROJECT_DISCOVERY_QUERY, variables).await?;

        let project = data
            .pointer("/repository/projectV2")
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "project not found in discovery response".to_string(),
            })?;

        let project_id = project
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "project ID not found".to_string(),
            })?
            .to_string();

        // Find the Status field
        let fields = project
            .pointer("/fields/nodes")
            .and_then(|v| v.as_array())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "project fields not found".to_string(),
            })?;

        let status_field_id = fields
            .iter()
            .find(|f| f.get("name").and_then(|n| n.as_str()) == Some("Status"))
            .and_then(|f| f.get("id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "Status field not found in project".to_string(),
            })?
            .to_string();

        info!(
            project_id = %project_id,
            status_field_id = %status_field_id,
            "project metadata discovered"
        );

        // Cache results
        {
            let mut node_id_lock = self.project_node_id.write().await;
            *node_id_lock = Some(project_id.clone());
        }
        {
            let mut field_id_lock = self.status_field_id.write().await;
            *field_id_lock = Some(status_field_id.clone());
        }

        Ok((project_id, status_field_id))
    }

    /// Fetch all project items with pagination, filtering by active states.
    async fn fetch_project_items(
        &self,
        filter_states: &[String],
    ) -> Result<Vec<Issue>, TrackerError> {
        let (project_id, _status_field_id) = self.ensure_project_metadata().await?;

        let mut all_issues = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let variables = json!({
                "projectId": project_id,
                "cursor": cursor,
            });

            let data = self.graphql(PROJECT_ITEMS_QUERY, variables).await?;

            let items_data = data
                .pointer("/node/items")
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "items not found in project response".to_string(),
                })?;

            let page_info = items_data
                .get("pageInfo")
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "pageInfo not found".to_string(),
                })?;

            let has_next = page_info
                .get("hasNextPage")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let nodes = items_data
                .pointer("/nodes")
                .and_then(|v| v.as_array())
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "items nodes not found".to_string(),
                })?;

            for node in nodes {
                if let Some(issue) =
                    self.normalize_project_item(node, filter_states)
                {
                    all_issues.push(issue);
                }
            }

            if has_next {
                cursor = page_info
                    .get("endCursor")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if cursor.is_none() {
                    return Err(TrackerError::MissingEndCursor);
                }
            } else {
                break;
            }
        }

        Ok(all_issues)
    }

    /// Normalize a single ProjectV2 item node into an Issue.
    /// Returns None if the item's status doesn't match the filter states
    /// or if the content is not an Issue.
    fn normalize_project_item(
        &self,
        node: &Value,
        filter_states: &[String],
    ) -> Option<Issue> {
        let content = node.get("content")?;

        // Must be an Issue (not Draft or PR)
        let id = content.get("id")?.as_str()?;
        let number = content.get("number")?.as_u64()?;
        let title = content.get("title")?.as_str()?;

        // Extract status from field values
        let status = self.extract_status_from_field_values(node);

        // Filter by status if filter_states is provided
        if !filter_states.is_empty() {
            let status_ref = status.as_deref().unwrap_or("");
            if !filter_states
                .iter()
                .any(|s| s.eq_ignore_ascii_case(status_ref))
            {
                return None;
            }
        }

        let body = content
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        let url = content
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let labels = extract_labels(content);
        let priority = extract_priority_from_field_values(node);

        let created_at = content
            .get("createdAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        let updated_at = content
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        let identifier = format!("{}#{}", self.repo, number);

        Some(Issue {
            id: id.to_string(),
            identifier,
            title: title.to_string(),
            description: body,
            priority,
            state: status.unwrap_or_else(|| "unknown".to_string()),
            branch_name: None,
            url,
            labels,
            blocked_by: vec![],
            created_at,
            updated_at,
        })
    }

    /// Extract the Status field value from a project item's fieldValues.
    fn extract_status_from_field_values(&self, node: &Value) -> Option<String> {
        let field_values = node
            .pointer("/fieldValues/nodes")
            .and_then(|v| v.as_array())?;

        for fv in field_values {
            let field_name = fv
                .pointer("/field/name")
                .and_then(|v| v.as_str());
            if field_name == Some("Status") {
                return fv.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
            }
        }
        None
    }

    /// Fetch repository issues without a project board.
    async fn fetch_repo_issues(
        &self,
        filter_states: &[String],
    ) -> Result<Vec<Issue>, TrackerError> {
        let mut all_issues = Vec::new();
        let mut cursor: Option<String> = None;

        let labels_param: Option<Vec<String>> = if !self.labels_filter.is_empty() {
            Some(self.labels_filter.clone())
        } else {
            None
        };

        loop {
            let variables = json!({
                "owner": self.owner,
                "repo": self.repo,
                "cursor": cursor,
                "labels": labels_param,
            });

            let data = self.graphql(REPO_ISSUES_QUERY, variables).await?;

            let issues_data = data
                .pointer("/repository/issues")
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "issues not found in repo response".to_string(),
                })?;

            let page_info = issues_data
                .get("pageInfo")
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "pageInfo not found".to_string(),
                })?;

            let has_next = page_info
                .get("hasNextPage")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let nodes = issues_data
                .get("nodes")
                .and_then(|v| v.as_array())
                .ok_or_else(|| TrackerError::UnexpectedPayload {
                    reason: "issue nodes not found".to_string(),
                })?;

            for node in nodes {
                if let Some(issue) = self.normalize_repo_issue(node, filter_states) {
                    all_issues.push(issue);
                }
            }

            if has_next {
                cursor = page_info
                    .get("endCursor")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if cursor.is_none() {
                    return Err(TrackerError::MissingEndCursor);
                }
            } else {
                break;
            }
        }

        Ok(all_issues)
    }

    /// Normalize a single repository issue node into an Issue.
    fn normalize_repo_issue(
        &self,
        node: &Value,
        filter_states: &[String],
    ) -> Option<Issue> {
        let id = node.get("id")?.as_str()?;
        let number = node.get("number")?.as_u64()?;
        let title = node.get("title")?.as_str()?;

        let labels = extract_labels(node);

        // Determine state from labels or open/closed
        let raw_state = node
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("open")
            .to_lowercase();

        // Map GitHub state to tracker state:
        // If labels contain any active_states value, use that.
        // Otherwise use open/closed.
        let state = labels
            .iter()
            .find(|l| {
                self.active_states
                    .iter()
                    .any(|s| s.eq_ignore_ascii_case(l))
                    || self
                        .terminal_states
                        .iter()
                        .any(|s| s.eq_ignore_ascii_case(l))
            })
            .cloned()
            .unwrap_or(raw_state);

        // Filter by state
        if !filter_states.is_empty()
            && !filter_states
                .iter()
                .any(|s| s.eq_ignore_ascii_case(&state))
        {
            return None;
        }

        let body = node
            .get("body")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        let url = node
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let created_at = node
            .get("createdAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        let updated_at = node
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<DateTime<Utc>>().ok());

        let identifier = format!("{}#{}", self.repo, number);

        Some(Issue {
            id: id.to_string(),
            identifier,
            title: title.to_string(),
            description: body,
            priority: None,
            state,
            branch_name: None,
            url,
            labels,
            blocked_by: vec![],
            created_at,
            updated_at,
        })
    }

    /// Batch fetch issue states by node IDs.
    async fn fetch_states_by_node_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let variables = json!({
            "ids": ids,
        });

        let data = self.graphql(ISSUE_STATES_QUERY, variables).await?;

        let nodes = data
            .get("nodes")
            .and_then(|v| v.as_array())
            .ok_or_else(|| TrackerError::UnexpectedPayload {
                reason: "nodes not found in state refresh response".to_string(),
            })?;

        let mut issues = Vec::new();
        for node in nodes {
            if node.is_null() {
                continue;
            }
            if let Some(issue) = self.normalize_state_node(node) {
                issues.push(issue);
            }
        }

        Ok(issues)
    }

    /// Normalize a node from the state refresh query.
    fn normalize_state_node(&self, node: &Value) -> Option<Issue> {
        let id = node.get("id")?.as_str()?;
        let number = node.get("number")?.as_u64()?;
        let title = node.get("title")?.as_str().unwrap_or("").to_string();

        let labels = extract_labels(node);

        // Try to get state from project items first
        let project_state = node
            .pointer("/projectItems/nodes")
            .and_then(|v| v.as_array())
            .and_then(|items| {
                for item in items {
                    let field_values = item
                        .pointer("/fieldValues/nodes")
                        .and_then(|v| v.as_array());
                    if let Some(fvs) = field_values {
                        for fv in fvs {
                            let field_name = fv
                                .pointer("/field/name")
                                .and_then(|v| v.as_str());
                            if field_name == Some("Status") {
                                return fv.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
                            }
                        }
                    }
                }
                None
            });

        let state = project_state.unwrap_or_else(|| {
            node.get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("open")
                .to_lowercase()
        });

        let url = node
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let identifier = format!("{}#{}", self.repo, number);

        Some(Issue {
            id: id.to_string(),
            identifier,
            title,
            description: None,
            priority: None,
            state,
            branch_name: None,
            url,
            labels,
            blocked_by: vec![],
            created_at: None,
            updated_at: None,
        })
    }
}

/// Parse "owner/repo" into (owner, repo).
fn parse_owner_repo(repository: &str) -> Result<(String, String), TrackerError> {
    let parts: Vec<&str> = repository.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(TrackerError::UnexpectedPayload {
            reason: format!(
                "invalid repository format '{}', expected 'owner/repo'",
                repository
            ),
        });
    }
    Ok((parts[0].to_string(), parts[1].to_string()))
}

/// Extract lowercased labels from a GitHub issue node.
fn extract_labels(node: &Value) -> Vec<String> {
    node.pointer("/labels/nodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l.get("name").and_then(|n| n.as_str()))
                .map(|s| s.to_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

/// Extract priority from project item field values.
///
/// Looks for a "Priority" single-select field and maps known values:
/// Urgent=1, High=2, Medium=3, Low=4.
fn extract_priority_from_field_values(node: &Value) -> Option<i32> {
    let field_values = node
        .pointer("/fieldValues/nodes")
        .and_then(|v| v.as_array())?;

    for fv in field_values {
        let field_name = fv
            .pointer("/field/name")
            .and_then(|v| v.as_str());
        if field_name == Some("Priority") {
            if let Some(value) = fv.get("name").and_then(|v| v.as_str()) {
                return match value.to_lowercase().as_str() {
                    "urgent" => Some(1),
                    "high" => Some(2),
                    "medium" => Some(3),
                    "low" => Some(4),
                    _ => None,
                };
            }
        }
    }
    None
}

#[async_trait]
impl IssueTracker for GithubTracker {
    /// Fetch candidate issues in active states for dispatch.
    ///
    /// When project_number is set: queries project board items.
    /// When not set: queries repository issues.
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        if self.project_number.is_some() {
            self.fetch_project_items(&self.active_states).await
        } else {
            self.fetch_repo_issues(&self.active_states).await
        }
    }

    /// Fetch issues in the given states (used for startup terminal cleanup).
    async fn fetch_issues_by_states(&self, states: &[String]) -> Result<Vec<Issue>, TrackerError> {
        if self.project_number.is_some() {
            self.fetch_project_items(states).await
        } else {
            self.fetch_repo_issues(states).await
        }
    }

    /// Fetch current states for specific issue IDs (used for reconciliation).
    async fn fetch_issue_states_by_ids(&self, ids: &[String]) -> Result<Vec<Issue>, TrackerError> {
        self.fetch_states_by_node_ids(ids).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Helper to create a GithubTracker pointed at a wiremock server.
    fn create_test_tracker(
        server_url: &str,
        project_number: Option<i64>,
    ) -> GithubTracker {
        GithubTracker::new(
            format!("{}/graphql", server_url),
            "ghp_test_token".to_string(),
            "acme/my-repo".to_string(),
            project_number,
            vec!["Todo".to_string(), "In Progress".to_string()],
            vec!["Done".to_string(), "Closed".to_string()],
            vec![],
        )
        .unwrap()
    }

    /// Build a GraphQL response body wrapping the given data.
    fn graphql_response(data: Value) -> Value {
        json!({ "data": data })
    }

    // --- parse_owner_repo tests ---

    #[test]
    fn test_parse_owner_repo_valid() {
        let (owner, repo) = parse_owner_repo("acme/my-repo").unwrap();
        assert_eq!(owner, "acme");
        assert_eq!(repo, "my-repo");
    }

    #[test]
    fn test_parse_owner_repo_with_org_slash() {
        let (owner, repo) = parse_owner_repo("my-org/my-repo").unwrap();
        assert_eq!(owner, "my-org");
        assert_eq!(repo, "my-repo");
    }

    #[test]
    fn test_parse_owner_repo_no_slash() {
        let result = parse_owner_repo("justarepo");
        assert!(matches!(result, Err(TrackerError::UnexpectedPayload { .. })));
    }

    #[test]
    fn test_parse_owner_repo_empty_parts() {
        assert!(parse_owner_repo("/repo").is_err());
        assert!(parse_owner_repo("owner/").is_err());
        assert!(parse_owner_repo("/").is_err());
    }

    // --- extract_labels tests ---

    #[test]
    fn test_extract_labels_lowercased() {
        let node = json!({
            "labels": {
                "nodes": [
                    { "name": "Bug" },
                    { "name": "ENHANCEMENT" },
                    { "name": "p1" }
                ]
            }
        });
        let labels = extract_labels(&node);
        assert_eq!(labels, vec!["bug", "enhancement", "p1"]);
    }

    #[test]
    fn test_extract_labels_empty() {
        let node = json!({});
        let labels = extract_labels(&node);
        assert!(labels.is_empty());
    }

    // --- extract_priority tests ---

    #[test]
    fn test_extract_priority_urgent() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "Urgent",
                        "field": { "name": "Priority" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), Some(1));
    }

    #[test]
    fn test_extract_priority_high() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "High",
                        "field": { "name": "Priority" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), Some(2));
    }

    #[test]
    fn test_extract_priority_medium() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "Medium",
                        "field": { "name": "Priority" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), Some(3));
    }

    #[test]
    fn test_extract_priority_low() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "Low",
                        "field": { "name": "Priority" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), Some(4));
    }

    #[test]
    fn test_extract_priority_none() {
        let node = json!({
            "fieldValues": {
                "nodes": []
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), None);
    }

    #[test]
    fn test_extract_priority_skips_non_priority_fields() {
        let node = json!({
            "fieldValues": {
                "nodes": [
                    {
                        "name": "Todo",
                        "field": { "name": "Status" }
                    }
                ]
            }
        });
        assert_eq!(extract_priority_from_field_values(&node), None);
    }

    // --- wiremock integration tests ---

    #[tokio::test]
    async fn test_fetch_candidates_with_project_board() {
        let server = MockServer::start().await;

        // Mock discovery query
        let discovery_response = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_test123",
                    "fields": {
                        "nodes": [
                            {
                                "id": "FIELD_status_1",
                                "name": "Status",
                                "options": [
                                    { "id": "OPT_1", "name": "Todo" },
                                    { "id": "OPT_2", "name": "In Progress" },
                                    { "id": "OPT_3", "name": "Done" }
                                ]
                            }
                        ]
                    }
                }
            }
        }));

        // Mock items query
        let items_response = graphql_response(json!({
            "node": {
                "items": {
                    "pageInfo": {
                        "hasNextPage": false,
                        "endCursor": null
                    },
                    "nodes": [
                        {
                            "fieldValues": {
                                "nodes": [
                                    {
                                        "name": "Todo",
                                        "field": { "name": "Status" }
                                    }
                                ]
                            },
                            "content": {
                                "id": "I_issue1",
                                "number": 1,
                                "title": "First issue",
                                "body": "Issue body",
                                "createdAt": "2025-01-01T00:00:00Z",
                                "updatedAt": "2025-01-02T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/1",
                                "labels": {
                                    "nodes": [
                                        { "name": "Bug" }
                                    ]
                                }
                            }
                        },
                        {
                            "fieldValues": {
                                "nodes": [
                                    {
                                        "name": "Done",
                                        "field": { "name": "Status" }
                                    }
                                ]
                            },
                            "content": {
                                "id": "I_issue2",
                                "number": 2,
                                "title": "Done issue",
                                "body": "",
                                "createdAt": "2025-01-01T00:00:00Z",
                                "updatedAt": "2025-01-02T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/2",
                                "labels": { "nodes": [] }
                            }
                        }
                    ]
                }
            }
        }));

        // The discovery query fires first, then the items query.
        // wiremock responds in order of registration when using respond_with_multiple.
        // We set up sequential responses on the same path.
        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(&discovery_response),
            )
            .expect(1)
            .named("discovery")
            .mount(&server)
            .await;

        // Need to drop the first mock before mounting the second.
        // Alternative: use respond_with for both in sequence.
        // wiremock v0.6 uses expect() to limit how many times a mock matches.
        // After the first request matches "discovery" (expect=1), the second
        // request will match the next mock.

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(&items_response),
            )
            .expect(1)
            .named("items")
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        // Only the Todo issue should be returned (Done is filtered out)
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].id, "I_issue1");
        assert_eq!(issues[0].identifier, "my-repo#1");
        assert_eq!(issues[0].title, "First issue");
        assert_eq!(issues[0].description.as_deref(), Some("Issue body"));
        assert_eq!(issues[0].state, "Todo");
        assert_eq!(issues[0].labels, vec!["bug"]);
        assert!(issues[0].url.is_some());
        assert!(issues[0].created_at.is_some());
        assert!(issues[0].updated_at.is_some());
    }

    #[tokio::test]
    async fn test_fetch_candidates_without_project_board() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": {
                        "hasNextPage": false,
                        "endCursor": null
                    },
                    "nodes": [
                        {
                            "id": "I_node1",
                            "number": 10,
                            "title": "Open issue",
                            "body": "Some body",
                            "createdAt": "2025-03-01T12:00:00Z",
                            "updatedAt": "2025-03-02T12:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/10",
                            "state": "OPEN",
                            "labels": {
                                "nodes": [
                                    { "name": "todo" }
                                ]
                            }
                        },
                        {
                            "id": "I_node2",
                            "number": 11,
                            "title": "Another issue",
                            "body": "",
                            "createdAt": "2025-03-01T13:00:00Z",
                            "updatedAt": "2025-03-02T13:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/11",
                            "state": "OPEN",
                            "labels": {
                                "nodes": [
                                    { "name": "done" }
                                ]
                            }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        // "todo" label matches active state "Todo" (case-insensitive), so it passes.
        // "done" label matches terminal state "Done", so it does NOT match active states.
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].identifier, "my-repo#10");
        assert_eq!(issues[0].labels, vec!["todo"]);
    }

    #[tokio::test]
    async fn test_pagination_two_pages() {
        let server = MockServer::start().await;

        let page1_response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": {
                        "hasNextPage": true,
                        "endCursor": "cursor_page2"
                    },
                    "nodes": [
                        {
                            "id": "I_p1",
                            "number": 1,
                            "title": "Page 1 issue",
                            "body": "",
                            "createdAt": "2025-01-01T00:00:00Z",
                            "updatedAt": "2025-01-01T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/1",
                            "state": "OPEN",
                            "labels": { "nodes": [{ "name": "todo" }] }
                        }
                    ]
                }
            }
        }));

        let page2_response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": {
                        "hasNextPage": false,
                        "endCursor": null
                    },
                    "nodes": [
                        {
                            "id": "I_p2",
                            "number": 2,
                            "title": "Page 2 issue",
                            "body": "",
                            "createdAt": "2025-01-02T00:00:00Z",
                            "updatedAt": "2025-01-02T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/2",
                            "state": "OPEN",
                            "labels": { "nodes": [{ "name": "in progress" }] }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&page1_response))
            .expect(1)
            .named("page1")
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&page2_response))
            .expect(1)
            .named("page2")
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].identifier, "my-repo#1");
        assert_eq!(issues[1].identifier, "my-repo#2");
    }

    #[tokio::test]
    async fn test_fetch_states_by_ids() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "nodes": [
                {
                    "id": "I_node1",
                    "number": 42,
                    "title": "Issue 42",
                    "state": "OPEN",
                    "url": "https://github.com/acme/my-repo/issues/42",
                    "labels": { "nodes": [{ "name": "bug" }] },
                    "projectItems": {
                        "nodes": [
                            {
                                "fieldValues": {
                                    "nodes": [
                                        {
                                            "name": "In Progress",
                                            "field": { "name": "Status" }
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                },
                null,
                {
                    "id": "I_node3",
                    "number": 99,
                    "title": "Issue 99",
                    "state": "CLOSED",
                    "url": "https://github.com/acme/my-repo/issues/99",
                    "labels": { "nodes": [] },
                    "projectItems": { "nodes": [] }
                }
            ]
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let issues = tracker
            .fetch_issue_states_by_ids(&[
                "I_node1".to_string(),
                "I_node_missing".to_string(),
                "I_node3".to_string(),
            ])
            .await
            .unwrap();

        assert_eq!(issues.len(), 2);

        // First issue has project Status = "In Progress"
        assert_eq!(issues[0].id, "I_node1");
        assert_eq!(issues[0].state, "In Progress");
        assert_eq!(issues[0].identifier, "my-repo#42");
        assert_eq!(issues[0].labels, vec!["bug"]);

        // Third issue has no project status, falls back to GitHub state
        assert_eq!(issues[1].id, "I_node3");
        assert_eq!(issues[1].state, "closed");
        assert_eq!(issues[1].identifier, "my-repo#99");
    }

    #[tokio::test]
    async fn test_fetch_states_empty_ids() {
        let tracker = GithubTracker::new(
            "https://api.github.com/graphql".to_string(),
            "token".to_string(),
            "acme/repo".to_string(),
            None,
            vec![],
            vec![],
            vec![],
        )
        .unwrap();

        // Empty IDs should return empty without making a request
        let issues = tracker
            .fetch_issue_states_by_ids(&[])
            .await
            .unwrap();
        assert!(issues.is_empty());
    }

    #[tokio::test]
    async fn test_error_non_200_status() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(401).set_body_string("Unauthorized"),
            )
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let result = tracker.fetch_candidate_issues().await;

        match result {
            Err(TrackerError::ApiStatus { status, body }) => {
                assert_eq!(status, 401);
                assert!(body.contains("Unauthorized"));
            }
            other => panic!("expected ApiStatus error, got: {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_error_graphql_errors() {
        let server = MockServer::start().await;

        let response = json!({
            "data": null,
            "errors": [
                { "message": "Field 'repository' not found" },
                { "message": "Another error" }
            ]
        });

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(&response),
            )
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let result = tracker.fetch_candidate_issues().await;

        match result {
            Err(TrackerError::GraphqlErrors { errors }) => {
                assert!(errors.contains("Field 'repository' not found"));
                assert!(errors.contains("Another error"));
            }
            other => panic!("expected GraphqlErrors, got: {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_error_malformed_payload() {
        let server = MockServer::start().await;

        // Valid JSON but no "data" field
        let response = json!({ "something": "else" });

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(&response),
            )
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let result = tracker.fetch_candidate_issues().await;

        assert!(matches!(
            result,
            Err(TrackerError::UnexpectedPayload { .. })
        ));
    }

    #[tokio::test]
    async fn test_normalization_labels_lowercased() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "id": "I_1",
                            "number": 1,
                            "title": "Test",
                            "body": "",
                            "createdAt": "2025-01-01T00:00:00Z",
                            "updatedAt": "2025-01-01T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/1",
                            "state": "OPEN",
                            "labels": {
                                "nodes": [
                                    { "name": "BUG" },
                                    { "name": "TODO" },
                                    { "name": "P1" }
                                ]
                            }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].labels, vec!["bug", "todo", "p1"]);
    }

    #[tokio::test]
    async fn test_normalization_identifier_format() {
        let server = MockServer::start().await;

        let response = graphql_response(json!({
            "repository": {
                "issues": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "id": "I_abc",
                            "number": 42,
                            "title": "Test",
                            "body": "",
                            "createdAt": "2025-01-01T00:00:00Z",
                            "updatedAt": "2025-01-01T00:00:00Z",
                            "url": "https://github.com/acme/my-repo/issues/42",
                            "state": "OPEN",
                            "labels": { "nodes": [{ "name": "todo" }] }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&response))
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), None);
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 1);
        // Identifier uses repo name (not owner/repo)
        assert_eq!(issues[0].identifier, "my-repo#42");
    }

    #[tokio::test]
    async fn test_normalization_priority_mapping_from_project() {
        let server = MockServer::start().await;

        // Discovery
        let discovery = graphql_response(json!({
            "repository": {
                "projectV2": {
                    "id": "PVT_1",
                    "fields": {
                        "nodes": [
                            {
                                "id": "F_status",
                                "name": "Status",
                                "options": []
                            }
                        ]
                    }
                }
            }
        }));

        // Items with priority field
        let items = graphql_response(json!({
            "node": {
                "items": {
                    "pageInfo": { "hasNextPage": false, "endCursor": null },
                    "nodes": [
                        {
                            "fieldValues": {
                                "nodes": [
                                    {
                                        "name": "Todo",
                                        "field": { "name": "Status" }
                                    },
                                    {
                                        "name": "High",
                                        "field": { "name": "Priority" }
                                    }
                                ]
                            },
                            "content": {
                                "id": "I_1",
                                "number": 1,
                                "title": "High priority",
                                "body": "",
                                "createdAt": "2025-01-01T00:00:00Z",
                                "updatedAt": "2025-01-01T00:00:00Z",
                                "url": "https://github.com/acme/my-repo/issues/1",
                                "labels": { "nodes": [] }
                            }
                        }
                    ]
                }
            }
        }));

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&discovery))
            .expect(1)
            .named("discovery")
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .respond_with(ResponseTemplate::new(200).set_body_json(&items))
            .expect(1)
            .named("items")
            .mount(&server)
            .await;

        let tracker = create_test_tracker(&server.uri(), Some(1));
        let issues = tracker.fetch_candidate_issues().await.unwrap();

        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].priority, Some(2)); // High = 2
    }
}
```

- [ ] **Step 2: Verify it compiles and tests pass**

Run: `cargo test -p ensemble-core tracker::github`
Expected: All tests pass (approximately 18 tests)

- [ ] **Step 3: Commit**

```bash
git add crates/ensemble-core/src/tracker/github.rs
git commit -m "feat: GithubTracker — GitHub Projects v2 GraphQL client with pagination and normalization"
```

---

### Task 5: Integration Test

**Files:**
- Create: `crates/ensemble-core/tests/tracker_integration.rs`

- [ ] **Step 1: Write the end-to-end integration test**

Create `crates/ensemble-core/tests/tracker_integration.rs`:

```rust
//! Integration test: create a todo_file tracker from config, write a TODO.md, fetch candidates.

use ensemble_core::config::typed::ServiceConfig;
use ensemble_core::config::workflow::parse_workflow;
use ensemble_core::tracker::create_tracker;
use tempfile::TempDir;

#[tokio::test]
async fn test_todo_file_tracker_via_factory() {
    let dir = TempDir::new().unwrap();
    let todo_path = dir.path().join("TODO.md");

    // Write a TODO.md
    std::fs::write(
        &todo_path,
        r#"## Todo
- [PROJ-1] Add login page
  The login page needs a form.
- [PROJ-2] Fix checkout bug

## In Progress
- [PROJ-3] Refactor auth module
  Breaking out the auth logic.

## Done
- [PROJ-4] Set up CI pipeline
"#,
    )
    .unwrap();

    // Build config from a WORKFLOW.md-like string
    let workflow_content = format!(
        r#"---
tracker:
  kind: todo_file
  path: {}
---
Do the work on {{{{ issue.identifier }}}}.
"#,
        todo_path.display()
    );

    let workflow = parse_workflow(&workflow_content).unwrap();
    let config = ServiceConfig::from_workflow(&workflow).unwrap();

    // Create tracker via factory
    let tracker = create_tracker(&config).unwrap();

    // Fetch candidates (active states: Todo, In Progress)
    let candidates = tracker.fetch_candidate_issues().await.unwrap();
    assert_eq!(candidates.len(), 3);

    // Verify ordering: document order
    assert_eq!(candidates[0].identifier, "PROJ-1");
    assert_eq!(candidates[0].title, "Add login page");
    assert_eq!(
        candidates[0].description.as_deref(),
        Some("The login page needs a form.")
    );
    assert_eq!(candidates[0].state, "Todo");
    assert_eq!(candidates[0].priority, Some(0));

    assert_eq!(candidates[1].identifier, "PROJ-2");
    assert_eq!(candidates[1].title, "Fix checkout bug");
    assert_eq!(candidates[1].description, None);
    assert_eq!(candidates[1].state, "Todo");
    assert_eq!(candidates[1].priority, Some(1));

    assert_eq!(candidates[2].identifier, "PROJ-3");
    assert_eq!(candidates[2].title, "Refactor auth module");
    assert_eq!(
        candidates[2].description.as_deref(),
        Some("Breaking out the auth logic.")
    );
    assert_eq!(candidates[2].state, "In Progress");
    assert_eq!(candidates[2].priority, Some(0));

    // Verify normalization: labels, blocked_by, branch_name, url are empty/null
    for issue in &candidates {
        assert!(issue.labels.is_empty());
        assert!(issue.blocked_by.is_empty());
        assert!(issue.branch_name.is_none());
        assert!(issue.url.is_none());
        assert!(issue.created_at.is_none());
        assert!(issue.updated_at.is_none());
    }
}

#[tokio::test]
async fn test_todo_file_tracker_fetch_by_states() {
    let dir = TempDir::new().unwrap();
    let todo_path = dir.path().join("TODO.md");

    std::fs::write(
        &todo_path,
        r#"## Todo
- [A] Alpha

## Done
- [B] Beta

## Blocked
- [C] Charlie
"#,
    )
    .unwrap();

    let mut config = ServiceConfig::default();
    config.tracker_kind = Some("todo_file".to_string());
    config.tracker_path = todo_path;

    let tracker = create_tracker(&config).unwrap();

    // Fetch terminal states
    let done = tracker
        .fetch_issues_by_states(&["Done".to_string()])
        .await
        .unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].identifier, "B");
    assert_eq!(done[0].state, "Done");

    // Fetch multiple states
    let multi = tracker
        .fetch_issues_by_states(&["Todo".to_string(), "Blocked".to_string()])
        .await
        .unwrap();
    assert_eq!(multi.len(), 2);
    assert_eq!(multi[0].identifier, "A");
    assert_eq!(multi[1].identifier, "C");
}

#[tokio::test]
async fn test_todo_file_tracker_fetch_states_by_ids() {
    let dir = TempDir::new().unwrap();
    let todo_path = dir.path().join("TODO.md");

    std::fs::write(
        &todo_path,
        r#"## Todo
- [X-1] First

## In Progress
- [X-2] Second

## Done
- [X-3] Third
"#,
    )
    .unwrap();

    let mut config = ServiceConfig::default();
    config.tracker_kind = Some("todo_file".to_string());
    config.tracker_path = todo_path;

    let tracker = create_tracker(&config).unwrap();

    let issues = tracker
        .fetch_issue_states_by_ids(&["X-1".to_string(), "X-3".to_string()])
        .await
        .unwrap();

    assert_eq!(issues.len(), 2);
    assert_eq!(issues[0].identifier, "X-1");
    assert_eq!(issues[0].state, "Todo");
    assert_eq!(issues[1].identifier, "X-3");
    assert_eq!(issues[1].state, "Done");
}

#[tokio::test]
async fn test_factory_rejects_unsupported_kind() {
    let mut config = ServiceConfig::default();
    config.tracker_kind = Some("jira".to_string());

    let result = create_tracker(&config);
    assert!(result.is_err());
}

#[tokio::test]
async fn test_factory_rejects_missing_kind() {
    let config = ServiceConfig::default();
    let result = create_tracker(&config);
    assert!(result.is_err());
}
```

- [ ] **Step 2: Run the integration test**

Run: `cargo test -p ensemble-core --test tracker_integration`
Expected: All 5 tests pass

- [ ] **Step 3: Run all tests one final time**

Run: `cargo test -p ensemble-core`
Expected: All tests pass (unit + integration from Plan 1 and Plan 2)

- [ ] **Step 4: Commit**

```bash
git add crates/ensemble-core/tests/tracker_integration.rs
git commit -m "test: end-to-end integration test for tracker factory with todo_file backend"
```

---

## Summary

After completing all 5 tasks, you will have:

- `reqwest` (with json feature) and `wiremock` added to the Cargo workspace dependencies
- **TodoFileTracker** (`tracker/todo_file.rs`): file-based issue tracker that parses `## <State>` / `- [ID] Title` Markdown format with:
  - Case-insensitive state matching against `active_states`
  - `[IDENTIFIER]` extraction or stable slug generation from title
  - Multi-line description parsing from indented continuation lines
  - Priority derived from document order (position within state section)
  - Graceful handling of missing files (returns empty list)
  - All three `IssueTracker` trait methods: `fetch_candidate_issues`, `fetch_issues_by_states`, `fetch_issue_states_by_ids`
- **Tracker factory** (`tracker/mod.rs`): `create_tracker(config)` function that matches on `tracker_kind` to return the correct `Box<dyn IssueTracker>`, with validation of required fields per tracker kind
- **GithubTracker** (`tracker/github.rs`): GitHub Projects v2 GraphQL client with:
  - `owner/repo` parsing from `tracker_repository`
  - Project metadata discovery (Project node ID + Status field ID) with caching
  - Two fetch modes: project board items (when `project_number` set) and repository issues (when not)
  - Cursor-based pagination with page size 50
  - Rate limit tracking via `X-RateLimit-Remaining` header
  - Issue normalization: lowercase labels, `repo#number` identifiers, Priority field mapping (Urgent=1, High=2, Medium=3, Low=4), ISO-8601 timestamp parsing
  - Batch state refresh by node IDs for reconciliation
  - All GraphQL queries as string constants (no codegen)
  - Comprehensive error handling: non-200 status, GraphQL errors, malformed payloads
- **Integration test** (`tests/tracker_integration.rs`): end-to-end test using the factory to create a `todo_file` tracker, write a `TODO.md`, fetch candidates, and verify full normalization

**Next:** Plan 3 will implement the core orchestration state machine (scheduler, reconciler, retry queue, worker communication).
