use async_trait::async_trait;
use std::path::PathBuf;
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
                let (identifier, title) =
                    extract_identifier_and_title(rest, state, position_in_state);

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
/// Otherwise generates a stable slug from the title, incorporating the state and
/// position to ensure uniqueness and handle non-alphanumeric-only titles.
fn extract_identifier_and_title(line: &str, state: &str, position: i32) -> (String, String) {
    if line.starts_with('[') {
        if let Some(end) = line.find(']') {
            let identifier = line[1..end].to_string();
            let title = line[end + 1..].trim().to_string();
            if !identifier.is_empty() {
                return (identifier, title);
            }
        }
    }
    // No bracketed identifier — generate a stable slug with position for uniqueness.
    // The position suffix ensures duplicate titles produce distinct identifiers,
    // and provides a fallback when the title contains no ASCII alphanumeric chars.
    let slug = generate_slug(line);
    let state_slug = generate_slug(state);
    let identifier = if slug.is_empty() {
        format!("{}-{}", state_slug, position)
    } else {
        format!("{}-{}-{}", state_slug, position, slug)
    };
    (identifier, line.to_string())
}

/// Generate a stable slug identifier from a title string.
///
/// Lowercases, replaces non-alphanumeric chars with hyphens, collapses
/// consecutive hyphens, and trims leading/trailing hyphens.
fn generate_slug(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
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
    states.iter().any(|s| s.eq_ignore_ascii_case(state))
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
    use std::path::Path;
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

        assert_eq!(issues[0].identifier, "todo-0-add-login-page");
        assert_eq!(issues[0].title, "Add login page");

        assert_eq!(issues[1].identifier, "todo-1-fix-the-checkout-bug");
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
        // Empty brackets -> fallback to slug with state-position prefix
        assert_eq!(issues[0].identifier, "todo-0-some-title");
        assert_eq!(issues[0].title, "[] Some title");
    }

    // --- extract_identifier_and_title tests ---

    #[test]
    fn test_extract_with_identifier() {
        let (id, title) = extract_identifier_and_title("[PROJ-1] Add login page", "Todo", 0);
        assert_eq!(id, "PROJ-1");
        assert_eq!(title, "Add login page");
    }

    #[test]
    fn test_extract_without_identifier() {
        let (id, title) = extract_identifier_and_title("Add login page", "Todo", 0);
        assert_eq!(id, "todo-0-add-login-page");
        assert_eq!(title, "Add login page");
    }

    #[test]
    fn test_extract_identifier_with_hash() {
        let (id, title) = extract_identifier_and_title("[my-repo#42] Fix bug", "Todo", 0);
        assert_eq!(id, "my-repo#42");
        assert_eq!(title, "Fix bug");
    }

    #[test]
    fn test_extract_non_alphanumeric_title_uses_fallback() {
        let (id, title) = extract_identifier_and_title("!!!", "Todo", 2);
        // Slug of "!!!" is empty, so falls back to state-position only
        assert_eq!(id, "todo-2");
        assert_eq!(title, "!!!");
    }

    #[test]
    fn test_extract_duplicate_titles_get_unique_ids() {
        let (id1, _) = extract_identifier_and_title("Fix bug", "Todo", 0);
        let (id2, _) = extract_identifier_and_title("Fix bug", "Todo", 1);
        assert_ne!(id1, id2);
        assert_eq!(id1, "todo-0-fix-bug");
        assert_eq!(id2, "todo-1-fix-bug");
    }

    // --- generate_slug tests ---

    #[test]
    fn test_slug_basic() {
        assert_eq!(generate_slug("Add login page"), "add-login-page");
    }

    #[test]
    fn test_slug_special_chars() {
        assert_eq!(generate_slug("Fix the bug! (urgent)"), "fix-the-bug-urgent");
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
