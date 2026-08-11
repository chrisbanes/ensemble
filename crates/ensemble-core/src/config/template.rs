use crate::error::ConfigError;
use crate::interaction::InteractionResponse;
use crate::pipeline::engine::StepOutputTemplateContext;
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
    render_prompt_with_context(template_str, issue, attempt, None, None)
}

pub fn render_prompt_with_interaction_response(
    template_str: &str,
    issue: &Issue,
    attempt: Option<u32>,
    interaction_response: Option<&InteractionResponse>,
) -> Result<String, ConfigError> {
    render_prompt_with_context(template_str, issue, attempt, interaction_response, None)
}

/// Render a Liquid prompt template with full context: issue, attempt, interaction response,
/// and step outputs.
///
/// This is the core rendering entry point used by [`render_prompt`] and
/// [`render_prompt_with_interaction_response`]. When `step_outputs` is provided, each key from the
/// serialized map is inserted directly into the Liquid globals so templates can reference fields
/// like `steps["review-a"].summary` or `dependency_outputs[0].result`.
pub fn render_prompt_with_context(
    template_str: &str,
    issue: &Issue,
    attempt: Option<u32>,
    interaction_response: Option<&InteractionResponse>,
    step_outputs: Option<&StepOutputTemplateContext>,
) -> Result<String, ConfigError> {
    let parser =
        ParserBuilder::with_stdlib()
            .build()
            .map_err(|e| ConfigError::TemplateParseError {
                reason: e.to_string(),
            })?;

    let template = parser
        .parse(template_str)
        .map_err(|e| ConfigError::TemplateParseError {
            reason: e.to_string(),
        })?;

    // Build the issue object for Liquid. Option fields use nil when absent so
    // templates can distinguish missing from empty via `{% if issue.description %}`.
    let mut issue_obj = liquid::object!({
        "id": issue.id,
        "identifier": issue.identifier,
        "title": issue.title,
        "priority": issue.priority,
        "state": issue.state,
        "labels": issue.labels,
    });

    // Optional fields are always present for issue.*, using nil when absent.
    issue_obj.insert(
        "description".into(),
        issue
            .description
            .as_ref()
            .map_or(liquid::model::Value::Nil, |desc| {
                liquid::model::Value::scalar(desc.clone())
            }),
    );
    issue_obj.insert(
        "branch_name".into(),
        issue
            .branch_name
            .as_ref()
            .map_or(liquid::model::Value::Nil, |branch_name| {
                liquid::model::Value::scalar(branch_name.clone())
            }),
    );
    issue_obj.insert(
        "url".into(),
        issue.url.as_ref().map_or(liquid::model::Value::Nil, |url| {
            liquid::model::Value::scalar(url.clone())
        }),
    );

    let mut globals = liquid::object!({
        "issue": issue_obj,
    });

    if let Some(a) = attempt {
        globals.insert("attempt".into(), liquid::model::Value::scalar(a as i64));
    }

    if let Some(response) = interaction_response {
        globals.insert(
            "interaction_response".into(),
            liquid::model::to_value(response).map_err(|e| ConfigError::TemplateRenderError {
                reason: e.to_string(),
            })?,
        );
    }

    if let Some(step_outputs) = step_outputs {
        let value = liquid::model::to_value(step_outputs).map_err(|e| {
            ConfigError::TemplateRenderError {
                reason: e.to_string(),
            }
        })?;
        if let liquid::model::Value::Object(object) = value {
            for (key, value) in object {
                globals.insert(key, value);
            }
        } else {
            return Err(ConfigError::TemplateRenderError {
                reason: "step_outputs did not serialize to a Liquid object".to_string(),
            });
        }
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
            tracker_position: None,
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
    fn test_render_missing_description_is_nil() {
        let mut issue = test_issue();
        issue.description = None;
        let template = "{% if issue.description %}has desc{% else %}no desc{% endif %}";
        let result = render_prompt(template, &issue, None).unwrap();
        assert_eq!(result, "no desc");
    }

    #[test]
    fn test_render_missing_description_direct_access_renders_empty() {
        let mut issue = test_issue();
        issue.description = None;
        let template = "{{ issue.description }}";
        let result = render_prompt(template, &issue, None).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn test_render_invalid_syntax() {
        let result = render_prompt("{{ unclosed", &test_issue(), None);
        assert!(matches!(
            result,
            Err(ConfigError::TemplateParseError { .. })
        ));
    }

    #[test]
    fn test_render_interaction_response() {
        let template = "{{ interaction_response.kind }}: {{ interaction_response.text }} / {{ interaction_response.selected_option }}";
        let response = InteractionResponse::Question {
            response_schema_version: 1,
            text: "Use staging".to_string(),
            selected_option: Some("staging".to_string()),
        };

        let result =
            render_prompt_with_interaction_response(template, &test_issue(), None, Some(&response))
                .unwrap();

        assert_eq!(result, "question: Use staging / staging");
    }

    #[test]
    fn test_render_with_step_outputs() {
        use crate::pipeline::engine::{StepOutputTemplateContext, StepOutputTemplateEntry};
        use serde_json::json;
        use std::collections::HashMap;

        let mut steps = HashMap::new();
        steps.insert(
            "review-a".to_string(),
            StepOutputTemplateEntry {
                step: "review-a".to_string(),
                result: "succeeded".to_string(),
                summary: Some("looks good".to_string()),
                output: Some(json!({"risk":"low"})),
            },
        );
        let context = StepOutputTemplateContext {
            steps: steps.clone(),
            dependency_outputs: vec![steps["review-a"].clone()],
        };

        let rendered = render_prompt_with_context(
            "{{ steps[\"review-a\"].summary }} / {{ dependency_outputs[0].output.risk }}",
            &test_issue(),
            None,
            None,
            Some(&context),
        )
        .unwrap();

        assert_eq!(rendered, "looks good / low");
    }
}
