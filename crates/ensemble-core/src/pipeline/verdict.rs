use std::fmt;

use serde::{Deserialize, Serialize};

use crate::config::ensemble::ResolvedOutputSchema;

/// The result returned by an agent at the end of a pipeline step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepResult {
    /// The step output succeeded; continue to the next step or mark success.
    Succeeded,
    /// The step output failed; retry or mark failure.
    Failed { summary: String },
    /// The step output raised a concern; continue according to pipeline policy.
    Concern { summary: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepOutput {
    pub result: StepResult,
    pub summary: Option<String>,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepOutputValidationError {
    message: String,
}

impl StepOutputValidationError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for StepOutputValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StepOutputValidationError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictStepOutputPayload {
    result: StrictStepResult,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    output: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StrictStepResult {
    Succeeded,
    Failed,
    Concern,
}

pub fn parse_step_output_json(text: &str) -> Result<StepOutput, StepOutputValidationError> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| {
        StepOutputValidationError::new(format!("invalid JSON step output: {error}"))
    })?;
    validate_step_output_value(&value)
}

pub fn validate_step_output_value(
    value: &serde_json::Value,
) -> Result<StepOutput, StepOutputValidationError> {
    validate_step_output_value_with_schema(value, None)
}

pub fn validate_step_output_value_with_schema(
    value: &serde_json::Value,
    output_schema: Option<&ResolvedOutputSchema>,
) -> Result<StepOutput, StepOutputValidationError> {
    let payload: StrictStepOutputPayload =
        serde_json::from_value(value.clone()).map_err(|error| {
            StepOutputValidationError::new(format!("invalid StepOutput payload: {error}"))
        })?;

    let summary = payload.summary.map(|value| value.trim().to_string());
    let result = match payload.result {
        StrictStepResult::Succeeded => StepResult::Succeeded,
        StrictStepResult::Failed => {
            let Some(summary) = summary.as_ref().filter(|value| !value.is_empty()) else {
                return Err(StepOutputValidationError::new(
                    "failed results require a non-empty summary",
                ));
            };
            StepResult::Failed {
                summary: summary.clone(),
            }
        }
        StrictStepResult::Concern => {
            let Some(summary) = summary.as_ref().filter(|value| !value.is_empty()) else {
                return Err(StepOutputValidationError::new(
                    "concern results require a non-empty summary",
                ));
            };
            StepResult::Concern {
                summary: summary.clone(),
            }
        }
    };

    if let Some(output_schema) = output_schema {
        let output = payload.output.as_ref().ok_or_else(|| {
            StepOutputValidationError::new("declared output_schema requires an output value")
        })?;
        let validator = jsonschema::validator_for(&output_schema.schema).map_err(|error| {
            StepOutputValidationError::new(format!("invalid resolved output_schema: {error}"))
        })?;
        let schema_error = validator.iter_errors(output).next().map(|error| {
            let location = error.instance_path.as_str();
            format!(
                "output does not satisfy declared schema at {}: {}",
                if location.is_empty() { "/" } else { location },
                error
            )
        });
        if let Some(schema_error) = schema_error {
            return Err(StepOutputValidationError::new(schema_error));
        }
    }

    Ok(StepOutput {
        result,
        summary,
        output: payload.output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_step_output_accepts_succeeded() {
        let output = validate_step_output_value(&json!({
            "result": "succeeded",
            "summary": "finished",
            "output": {"branch": "issue-184"}
        }))
        .unwrap();

        assert_eq!(output.result, StepResult::Succeeded);
        assert_eq!(output.summary.as_deref(), Some("finished"));
        assert_eq!(output.output, Some(json!({"branch": "issue-184"})));
    }

    #[test]
    fn validate_step_output_requires_summary_for_failed() {
        let err = validate_step_output_value(&json!({"result": "failed"})).unwrap_err();

        assert!(
            err.to_string()
                .contains("failed results require a non-empty summary"),
            "{err}"
        );
    }

    #[test]
    fn validate_step_output_requires_summary_for_concern() {
        let err = validate_step_output_value(&json!({
            "result": "concern",
            "summary": "   "
        }))
        .unwrap_err();

        assert!(
            err.to_string()
                .contains("concern results require a non-empty summary"),
            "{err}"
        );
    }

    #[test]
    fn validate_step_output_rejects_legacy_verdict_key() {
        let err = validate_step_output_value(&json!({
            "verdict": "approve",
            "summary": "legacy"
        }))
        .unwrap_err();

        assert!(err.to_string().contains("unknown field `verdict`"), "{err}");
    }

    #[test]
    fn validate_step_output_rejects_unknown_keys() {
        let err = validate_step_output_value(&json!({
            "result": "succeeded",
            "extra": true
        }))
        .unwrap_err();

        assert!(err.to_string().contains("unknown field `extra`"), "{err}");
    }

    #[test]
    fn parse_step_output_json_rejects_non_json_text() {
        let err = parse_step_output_json("approved, looks good").unwrap_err();

        assert!(
            err.to_string().contains("invalid JSON step output"),
            "{err}"
        );
    }

    #[test]
    fn declared_schema_requires_and_validates_output_for_every_result() {
        let schema = ResolvedOutputSchema {
            schema: json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "required": ["branch"],
                "properties": {"branch": {"type": "string"}}
            }),
        };

        let missing = validate_step_output_value_with_schema(
            &json!({"result": "failed", "summary": "blocked"}),
            Some(&schema),
        )
        .unwrap_err();
        assert!(missing.to_string().contains("requires an output"));

        let invalid = validate_step_output_value_with_schema(
            &json!({"result": "concern", "summary": "check", "output": {"branch": 3}}),
            Some(&schema),
        )
        .unwrap_err();
        assert!(invalid.to_string().contains("/branch"));

        let output = validate_step_output_value_with_schema(
            &json!({"result": "succeeded", "output": {"branch": "issue-479"}}),
            Some(&schema),
        )
        .unwrap();
        assert_eq!(output.output, Some(json!({"branch": "issue-479"})));
    }
}
