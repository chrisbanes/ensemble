use crate::error::AgentError;
use crate::pipeline::verdict::{parse_step_output_json, validate_step_output_value, StepOutput};

pub(crate) fn build_extraction_prompt(
    step_name: &str,
    issue_identifier: &str,
    original_prompt: &str,
    working_answer: &str,
) -> String {
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
         - Omit output when there is no structured downstream data.\n\
         - Do not include any keys other than result, summary, and output."
    )
}

pub(crate) fn build_repair_prompt(validation_error: &str, previous_payload: &str) -> String {
    format!(
        "The previous Ensemble step result was invalid.\n\n\
         Validation error:\n\
         {validation_error}\n\n\
         Previous payload:\n\
         {previous_payload}\n\n\
         Return only the corrected JSON object using exactly these keys: result, summary, output. \
         The result value must be one of succeeded, failed, or concern. Failed and concern require a non-empty summary."
    )
}

pub(crate) fn validate_extraction_payload(
    runtime_payload: Option<&serde_json::Value>,
    output_text: &str,
) -> Result<StepOutput, AgentError> {
    if let Some(value) = runtime_payload {
        return validate_step_output_value(value).map_err(|error| AgentError::ResponseError {
            reason: error.to_string(),
        });
    }

    parse_step_output_json(output_text.trim()).map_err(|error| AgentError::ResponseError {
        reason: error.to_string(),
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
        );

        assert!(prompt.contains("failed results require a non-empty summary"));
        assert!(prompt.contains("{\"result\":\"failed\"}"));
        assert!(prompt.contains("Return only the corrected JSON object"));
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
