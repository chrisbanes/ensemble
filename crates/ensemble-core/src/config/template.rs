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
