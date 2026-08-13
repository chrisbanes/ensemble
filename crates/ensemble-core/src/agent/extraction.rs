use crate::config::ensemble::ResolvedOutputSchema;
use crate::error::AgentError;
use crate::pipeline::verdict::{validate_step_output_value_with_schema, StepOutput};

pub(crate) fn build_extraction_prompt(
    step_name: &str,
    issue_identifier: &str,
    original_prompt: &str,
    working_answer: &str,
    output_schema: Option<&ResolvedOutputSchema>,
) -> String {
    let configured_output = configured_output_instructions(output_schema);
    format!(
        "Extract the Ensemble step result from the completed working turn.\n\n\
         Step: {step_name}\n\
         Issue: {issue_identifier}\n\n\
         Original step prompt:\n\
         ---\n\
         {original_prompt}\n\
         ---\n\n\
         Visible working answer:\n\
         ---\n\
         {working_answer}\n\
         ---\n\n\
         Required JSON schema, expressed by example:\n\
         {{\n\
           \"result\": \"succeeded | failed | concern\",\n\
           \"summary\": \"required for failed or concern; optional for succeeded\",\n\
           \"output\": {{}}\n\
         }}\n\n\
         Rules:\n\
         - Return only a JSON object.\n\
         - Use result=succeeded only when the working answer completed the step.\n\
         - Use result=failed for blocking failures and include a non-empty summary.\n\
         - Use result=concern for non-blocking concerns and include a non-empty summary.\n\
         {configured_output}\n\
         - Do not include any keys other than result, summary, and output."
    )
}

pub(crate) fn build_repair_prompt(
    validation_error: &str,
    previous_payload: &str,
    output_schema: Option<&ResolvedOutputSchema>,
) -> String {
    let configured_output = configured_output_instructions(output_schema);
    format!(
        "The previous Ensemble step result was invalid.\n\n\
         Validation error:\n\
         {validation_error}\n\n\
         Previous payload:\n\
         {previous_payload}\n\n\
         Return only the corrected JSON object using exactly these keys: result, summary, output. \
         The result value must be one of succeeded, failed, or concern. Failed and concern require a non-empty summary.\n\
         {configured_output}"
    )
}

fn configured_output_instructions(output_schema: Option<&ResolvedOutputSchema>) -> String {
    match output_schema {
        Some(output_schema) => format!(
            "- Include output, and make its value satisfy this configured JSON Schema exactly:\n{}",
            serde_json::to_string_pretty(&output_schema.schema)
                .expect("serializing a parsed JSON Schema cannot fail")
        ),
        None => "- Omit output when there is no structured downstream data.".to_string(),
    }
}

#[cfg(test)]
pub(crate) fn validate_extraction_payload(
    runtime_payload: Option<&serde_json::Value>,
    output_text: &str,
) -> Result<StepOutput, AgentError> {
    validate_extraction_payload_with_schema(runtime_payload, output_text, None)
}

pub(crate) fn validate_extraction_payload_with_schema(
    runtime_payload: Option<&serde_json::Value>,
    output_text: &str,
    output_schema: Option<&ResolvedOutputSchema>,
) -> Result<StepOutput, AgentError> {
    let value = if let Some(value) = runtime_payload {
        value.clone()
    } else {
        serde_json::from_str(output_text.trim()).map_err(|error| AgentError::ResponseError {
            reason: format!("invalid JSON step output: {error}"),
        })?
    };
    validate_step_output_value_with_schema(&value, output_schema).map_err(|error| {
        AgentError::ResponseError {
            reason: error.to_string(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::verdict::StepResult;
    use serde_json::json;

    #[test]
    fn extraction_prompt_contains_context_and_schema() {
        let prompt = build_extraction_prompt(
            "review",
            "repo#184",
            "Review this change",
            "The implementation is sound.",
            None,
        );

        assert!(prompt.contains("Step: review"));
        assert!(prompt.contains("Issue: repo#184"));
        assert!(prompt.contains("Review this change"));
        assert!(prompt.contains("The implementation is sound."));
        assert!(prompt.contains("\"result\": \"succeeded | failed | concern\""));
        assert!(prompt.contains("Return only a JSON object"));
    }

    #[test]
    fn repair_prompt_contains_error_and_previous_payload() {
        let prompt = build_repair_prompt(
            "failed results require a non-empty summary",
            "{\"result\":\"failed\"}",
            None,
        );

        assert!(prompt.contains("failed results require a non-empty summary"));
        assert!(prompt.contains("{\"result\":\"failed\"}"));
        assert!(prompt.contains("Return only the corrected JSON object"));
    }

    #[test]
    fn extraction_and_repair_prompts_include_configured_output_schema() {
        let schema = ResolvedOutputSchema {
            schema: json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "required": ["paths"],
                "properties": {"paths": {"type": "array", "items": {"type": "string"}}}
            }),
        };

        let extraction = build_extraction_prompt(
            "build",
            "repo#184",
            "Build the change",
            "Done",
            Some(&schema),
        );
        let repair = build_repair_prompt(
            "output does not satisfy declared schema",
            r#"{"result":"succeeded","output":{}}"#,
            Some(&schema),
        );

        for prompt in [extraction, repair] {
            assert!(prompt.contains("make its value satisfy this configured JSON Schema exactly"));
            assert!(prompt.contains(r#""required": ["#));
            assert!(prompt.contains(r#""paths""#));
            assert!(prompt.contains(r#""type": "array""#));
        }
    }

    #[test]
    fn validate_extraction_payload_prefers_runtime_payload() {
        let output = validate_extraction_payload(
            Some(&json!({"result":"failed","summary":"tests failed"})),
            "{\"result\":\"succeeded\"}",
        )
        .unwrap();

        assert_eq!(
            output.result,
            StepResult::Failed {
                summary: "tests failed".to_string()
            }
        );
    }

    #[test]
    fn validate_extraction_payload_parses_hidden_text_without_runtime_payload() {
        let output = validate_extraction_payload(None, "{\"result\":\"succeeded\"}").unwrap();

        assert_eq!(output.result, StepResult::Succeeded);
    }

    #[test]
    fn validate_extraction_payload_reports_validation_error() {
        let err = validate_extraction_payload(None, "{\"result\":\"failed\"}").unwrap_err();

        assert!(
            err.to_string()
                .contains("failed results require a non-empty summary"),
            "{err}"
        );
    }
}
