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
///
/// Limitation: the closing `---` is found by simple string search. A YAML block
/// scalar that contains a literal `\n---` line will be mis-parsed. This matches
/// the behavior of Jekyll/Hugo front matter and is acceptable because WORKFLOW.md
/// front matter is always simple key-value config, never multi-line block scalars.
pub fn parse_workflow(content: &str) -> Result<WorkflowDefinition, ConfigError> {
    if let Some(rest) = content.strip_prefix("---") {
        // Find the closing ---
        if let Some(end_idx) = rest.find("\n---") {
            let yaml_str = &rest[..end_idx];
            let body = &rest[end_idx + 4..]; // skip past \n---

            let yaml_value: Value =
                serde_yaml::from_str(yaml_str).map_err(|e| ConfigError::WorkflowParseError {
                    reason: e.to_string(),
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
        assert!(matches!(
            result,
            Err(ConfigError::WorkflowParseError { .. })
        ));
    }

    #[test]
    fn test_parse_unclosed_front_matter() {
        let content = "---\ntracker:\n  kind: github\nNo closing delimiter";
        let result = parse_workflow(content);
        assert!(matches!(
            result,
            Err(ConfigError::WorkflowParseError { .. })
        ));
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
        std::fs::write(&path, "---\ntracker:\n  kind: github\n---\nDo the work.").unwrap();
        let wf = load_workflow(&path).unwrap();
        assert!(wf.config.contains_key("tracker"));
        assert_eq!(wf.prompt_template, "Do the work.");
    }
}
