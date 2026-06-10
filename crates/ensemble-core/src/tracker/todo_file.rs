use async_trait::async_trait;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::path::PathBuf;
use tempfile::NamedTempFile;
use tracing::warn;

use super::model::{InteractionThreadRoot, Issue, TrackerComment};
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
    async fn parse_file(&self) -> Result<Vec<ParsedIssue>, TrackerError> {
        let content = match tokio::fs::read_to_string(&self.path).await {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                warn!(path = %self.path.display(), "TODO file not found, returning empty list");
                return Ok(vec![]);
            }
            Err(e) => {
                return Err(TrackerError::IoError {
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

    let mut in_list_item = false;
    let mut in_h2 = false;
    let mut heading_parts: Vec<String> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();

    for (event, _range) in Parser::new_ext(content, Options::empty()).into_offset_iter() {
        match &event {
            Event::Start(Tag::Heading { level, .. }) if *level == HeadingLevel::H2 => {
                current_state = None;
                in_h2 = true;
                heading_parts.clear();
            }
            Event::Start(Tag::Item) => {
                in_list_item = true;
                text_parts.clear();
            }
            Event::Text(text) | Event::Code(text) => {
                if in_h2 {
                    heading_parts.push(text.to_string());
                } else if in_list_item {
                    if let Some(last) = text_parts.last_mut() {
                        last.push_str(text);
                    } else {
                        text_parts.push(text.to_string());
                    }
                }
            }
            Event::SoftBreak | Event::HardBreak if in_list_item => {
                text_parts.push(String::new());
            }
            Event::End(TagEnd::Heading(_)) => {
                if in_h2 && !heading_parts.is_empty() {
                    let joined = heading_parts.join("");
                    let trimmed = joined.trim().to_string();
                    if !trimmed.is_empty() {
                        current_state = Some(trimmed);
                        position_in_state = 0;
                    }
                }
                in_h2 = false;
                heading_parts.clear();
            }
            Event::End(TagEnd::Item) => {
                if in_list_item && !text_parts.is_empty() {
                    if let Some(state) = &current_state {
                        let title_line = text_parts.remove(0).trim().to_string();
                        let (identifier, title) =
                            extract_identifier_and_title(&title_line, state, position_in_state);

                        let description = if text_parts.is_empty() {
                            None
                        } else {
                            Some(text_parts.join("\n"))
                        };

                        issues.push(ParsedIssue {
                            identifier,
                            title,
                            description,
                            state: state.clone(),
                            priority: position_in_state,
                        });
                        position_in_state += 1;
                    }
                }
                in_list_item = false;
                text_parts.clear();
            }
            _ => {}
        }
    }

    issues
}

/// Extract identifier and title from a list item.
///
/// If the line starts with `[IDENTIFIER]`, extracts the identifier and remaining title.
/// Otherwise generates a stable identifier from state + position.
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
    // No bracketed identifier — generate a stable state+position identifier.
    let state_slug = generate_slug(state);
    let identifier = format!("{}-{}", state_slug, position);
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

fn collect_issue_block(lines: &[&str], start_idx: usize) -> (Vec<String>, usize) {
    let mut issue_block: Vec<String> = vec![lines[start_idx].to_string()];
    let mut end_idx = start_idx + 1;
    while end_idx < lines.len() {
        let line = lines[end_idx];
        // A continuation line is either blank or starts with whitespace.
        if line.is_empty() || line.starts_with("  ") || line.starts_with('\t') {
            issue_block.push(line.to_string());
            end_idx += 1;
        } else {
            break;
        }
    }

    // Trim trailing blank lines from the issue block so we don't accumulate extra whitespace.
    while issue_block
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        issue_block.pop();
    }

    (issue_block, end_idx)
}

fn locate_issue_block(lines: &[&str], id: &str) -> Option<(usize, usize, Vec<String>)> {
    let mut current_state: Option<String> = None;
    // Generated IDs depend on `(state, position_in_state, title_slug)`, so this counter must
    // mirror parse order for the *current file snapshot*. If list order changes between runs,
    // generated IDs for no-bracket items may also change.
    let mut position_in_state: i32 = 0;

    for (idx, line) in lines.iter().enumerate() {
        if let Some(heading) = line.strip_prefix("## ") {
            let heading = heading.trim();
            if !heading.is_empty() {
                current_state = Some(heading.to_string());
                position_in_state = 0;
            }
            continue;
        }

        let Some(rest) = line.strip_prefix("- ") else {
            continue;
        };
        let Some(state) = current_state.as_ref() else {
            continue;
        };

        let rest = rest.trim();
        let (parsed_id, title) = extract_identifier_and_title(rest, state, position_in_state);
        position_in_state += 1;

        if parsed_id != id {
            continue;
        }

        let (mut issue_lines, end_idx) = collect_issue_block(lines, idx);
        let explicit_identifier = rest.starts_with('[')
            && rest
                .find(']')
                .map(|end| !rest[1..end].trim().is_empty())
                .unwrap_or(false);

        if !explicit_identifier {
            let rewritten_first_line = if title.is_empty() {
                format!("- [{id}]")
            } else {
                format!("- [{id}] {title}")
            };
            if let Some(first_line) = issue_lines.first_mut() {
                *first_line = rewritten_first_line;
            }
        }

        return Some((idx, end_idx, issue_lines));
    }

    None
}

#[async_trait]
impl IssueTracker for TodoFileTracker {
    /// Fetch candidate issues in active states for dispatch.
    ///
    /// Reads the file, parses all issues, returns those in active states.
    async fn fetch_candidate_issues(&self) -> Result<Vec<Issue>, TrackerError> {
        let parsed = self.parse_file().await?;
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
        let parsed = self.parse_file().await?;
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
        let parsed = self.parse_file().await?;
        let issues = parsed
            .iter()
            .filter(|p| ids.iter().any(|id| id == &p.identifier))
            .map(to_issue)
            .collect();
        Ok(issues)
    }

    fn supports_writes(&self) -> bool {
        true
    }

    /// Move an issue to a different state section in the TODO file.
    ///
    /// Reads the file, finds the issue block matching `[{id}]`, removes it from its
    /// current section, and inserts it under the `## {target_state}` heading.
    /// If the heading does not exist, it is appended at the end of the file.
    async fn set_issue_state(&self, id: &str, target_state: &str) -> Result<(), TrackerError> {
        let content =
            tokio::fs::read_to_string(&self.path)
                .await
                .map_err(|e| TrackerError::IoError {
                    reason: format!("failed to read {}: {}", self.path.display(), e),
                })?;

        let lines: Vec<&str> = content.lines().collect();

        // Identify the issue block from parsed identifiers so both bracketed IDs and
        // generated slug IDs can be transitioned.
        let (issue_line_idx, end_idx, issue_block) = match locate_issue_block(&lines, id) {
            Some(result) => result,
            None => {
                return Err(TrackerError::IoError {
                    reason: format!("issue [{id}] not found in {}", self.path.display()),
                });
            }
        };

        // Build the new file content without the issue block.
        let mut new_lines: Vec<String> = lines
            .iter()
            .enumerate()
            .filter(|(i, _)| *i < issue_line_idx || *i >= end_idx)
            .map(|(_, l)| l.to_string())
            .collect();

        // Find the target heading index in the new_lines vector.
        let target_heading = format!("## {target_state}");
        let heading_idx = new_lines
            .iter()
            .position(|l| l.trim() == target_heading.trim());

        match heading_idx {
            Some(h_idx) => {
                // Insert the issue block right after the heading (and any blank line that
                // immediately follows it).
                let insert_at = if new_lines
                    .get(h_idx + 1)
                    .map(|l| l.trim().is_empty())
                    .unwrap_or(false)
                {
                    h_idx + 2
                } else {
                    h_idx + 1
                };
                for (offset, issue_line) in issue_block.iter().enumerate() {
                    new_lines.insert(insert_at + offset, issue_line.clone());
                }
            }
            None => {
                // Heading doesn't exist — append it at the end of the file.
                // Ensure there is a blank separator before the new heading.
                if new_lines
                    .last()
                    .map(|l| !l.trim().is_empty())
                    .unwrap_or(false)
                {
                    new_lines.push(String::new());
                }
                new_lines.push(target_heading);
                new_lines.push(String::new());
                new_lines.extend(issue_block);
            }
        }

        // Reconstruct file content, preserving a single trailing newline.
        let mut output = new_lines.join("\n");
        if !output.ends_with('\n') {
            output.push('\n');
        }

        // Atomic write: write through NamedTempFile in the same directory, then persist (rename).
        let parent = self
            .path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        let tmp = NamedTempFile::new_in(parent).map_err(|e| TrackerError::IoError {
            reason: format!("failed to create temp file in {}: {}", parent.display(), e),
        })?;
        tokio::fs::write(tmp.path(), &output)
            .await
            .map_err(|e| TrackerError::IoError {
                reason: format!("failed to write temp file: {e}"),
            })?;
        if let Err(e) = tmp.persist(&self.path) {
            return Err(TrackerError::IoError {
                reason: format!(
                    "failed to persist temp file to {}: {}",
                    self.path.display(),
                    e
                ),
            });
        }

        Ok(())
    }

    async fn create_interaction_thread_root(
        &self,
        _id: &str,
        _body: &str,
    ) -> Result<InteractionThreadRoot, TrackerError> {
        Err(TrackerError::WritesNotSupported)
    }

    async fn list_comments_after(
        &self,
        _id: &str,
        _after_comment_id: &str,
    ) -> Result<Vec<TrackerComment>, TrackerError> {
        Err(TrackerError::WritesNotSupported)
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

        assert_eq!(issues[0].identifier, "todo-0");
        assert_eq!(issues[0].title, "Add login page");

        assert_eq!(issues[1].identifier, "todo-1");
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
        // Empty brackets -> fallback to state-position identifier
        assert_eq!(issues[0].identifier, "todo-0");
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
        assert_eq!(id, "todo-0");
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
        assert_eq!(id1, "todo-0");
        assert_eq!(id2, "todo-1");
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

    // --- set_issue_state tests ---

    #[test]
    fn test_supports_writes_true() {
        let tracker = TodoFileTracker::new(std::path::PathBuf::from("/dev/null"), active_states());
        assert!(tracker.supports_writes());
    }

    #[tokio::test]
    async fn test_set_issue_state_moves_issue() {
        let dir = TempDir::new().unwrap();
        let content = r#"## Todo
- [PROJ-1] First task
  Some description.
- [PROJ-2] Second task

## In Progress
- [PROJ-3] Active task
"#;
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path.clone(), active_states());

        tracker
            .set_issue_state("PROJ-1", "In Progress")
            .await
            .unwrap();

        // Re-parse to confirm the move
        let all_issues = tracker
            .fetch_issues_by_states(&["Todo".to_string(), "In Progress".to_string()])
            .await
            .unwrap();

        // PROJ-1 should now be In Progress
        let proj1 = all_issues
            .iter()
            .find(|i| i.identifier == "PROJ-1")
            .unwrap();
        assert_eq!(proj1.state, "In Progress");

        // PROJ-2 should remain in Todo
        let proj2 = all_issues
            .iter()
            .find(|i| i.identifier == "PROJ-2")
            .unwrap();
        assert_eq!(proj2.state, "Todo");

        // PROJ-3 should still be In Progress
        let proj3 = all_issues
            .iter()
            .find(|i| i.identifier == "PROJ-3")
            .unwrap();
        assert_eq!(proj3.state, "In Progress");

        // Verify PROJ-1 comes before PROJ-3 in the In Progress section
        // (it was inserted right after the heading)
        let in_progress: Vec<_> = all_issues
            .iter()
            .filter(|i| i.state == "In Progress")
            .collect();
        assert_eq!(in_progress[0].identifier, "PROJ-1");
        assert_eq!(in_progress[1].identifier, "PROJ-3");
    }

    #[tokio::test]
    async fn test_set_issue_state_creates_new_heading() {
        let dir = TempDir::new().unwrap();
        let content = r#"## Todo
- [PROJ-1] First task
- [PROJ-2] Second task
"#;
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path.clone(), active_states());

        // Move PROJ-1 to "Done" — a heading that doesn't exist yet
        tracker.set_issue_state("PROJ-1", "Done").await.unwrap();

        // Fetch all issues including Done
        let done_issues = tracker
            .fetch_issues_by_states(&["Done".to_string()])
            .await
            .unwrap();
        assert_eq!(done_issues.len(), 1);
        assert_eq!(done_issues[0].identifier, "PROJ-1");
        assert_eq!(done_issues[0].state, "Done");

        // PROJ-2 should still be in Todo
        let todo_issues = tracker
            .fetch_issues_by_states(&["Todo".to_string()])
            .await
            .unwrap();
        assert_eq!(todo_issues.len(), 1);
        assert_eq!(todo_issues[0].identifier, "PROJ-2");

        // The "## Done" heading must be present in the file
        let written = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(
            written.contains("## Done"),
            "expected '## Done' heading in file"
        );
    }

    #[tokio::test]
    async fn test_set_issue_state_moves_slug_identifier_and_bracketizes_line() {
        let dir = TempDir::new().unwrap();
        let content = r#"## Todo
- Configure build toolchain
  Verify all dependencies resolve.

## In Progress
"#;
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path.clone(), active_states());

        let generated_id = "todo-0";
        tracker
            .set_issue_state(generated_id, "In Progress")
            .await
            .unwrap();

        let all_issues = tracker
            .fetch_issues_by_states(&["Todo".to_string(), "In Progress".to_string()])
            .await
            .unwrap();
        let moved = all_issues
            .iter()
            .find(|issue| issue.identifier == generated_id)
            .unwrap();
        assert_eq!(moved.state, "In Progress");

        let written = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(written.contains("- [todo-0] Configure build toolchain"));
    }

    #[tokio::test]
    async fn test_set_issue_state_slug_identifier_can_transition_again() {
        let dir = TempDir::new().unwrap();
        let content = r#"## Todo
- Do the thing

## In Progress

## Done
"#;
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path, active_states());

        let generated_id = "todo-0";
        tracker
            .set_issue_state(generated_id, "In Progress")
            .await
            .unwrap();
        tracker.set_issue_state(generated_id, "Done").await.unwrap();

        let done = tracker
            .fetch_issues_by_states(&["Done".to_string()])
            .await
            .unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].identifier, generated_id);
        assert_eq!(done[0].state, "Done");
    }

    #[tokio::test]
    async fn test_set_issue_state_whitespace_only_title_item() {
        let dir = TempDir::new().unwrap();
        let content = r#"## Todo
-   

## In Progress
"#;
        let path = write_todo(dir.path(), content);
        let tracker = TodoFileTracker::new(path.clone(), active_states());

        tracker
            .set_issue_state("todo-0", "In Progress")
            .await
            .unwrap();

        let in_progress = tracker
            .fetch_issues_by_states(&["In Progress".to_string()])
            .await
            .unwrap();
        assert_eq!(in_progress.len(), 1);
        assert_eq!(in_progress[0].identifier, "todo-0");

        let written = tokio::fs::read_to_string(path).await.unwrap();
        assert!(written.contains("- [todo-0]"));
    }
}
