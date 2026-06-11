use std::path::Path;

use serde::Deserialize;
use tracing::warn;

/// The result returned by an agent at the end of a pipeline step.
#[derive(Debug, Clone, PartialEq)]
pub enum StepResult {
    /// The step output succeeded; continue to the next step or mark success.
    Succeeded,
    /// The step output failed; retry or mark failure.
    Failed { summary: String },
    /// The step output raised a concern; continue according to pipeline policy.
    Concern { summary: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerdictSource {
    Runtime,
    File,
    Default,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepOutput {
    pub result: StepResult,
    pub summary: Option<String>,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedResult {
    pub result: StepResult,
    pub output: StepOutput,
    pub source: VerdictSource,
}

/// Internal deserialization type for both ACP JSON values and verdict files.
#[derive(Debug, Deserialize)]
struct VerdictPayload {
    result: Option<String>,
    verdict: Option<String>,
    summary: Option<String>,
    #[serde(default)]
    output: Option<serde_json::Value>,
}

/// Parse a [`StepResult`] from an arbitrary JSON value (e.g. an ACP event body).
///
/// Recognises `"approve"`/`"succeeded"` (case-insensitive) →
/// [`StepResult::Succeeded`], `"reject"`/`"failed"` (case-insensitive) →
/// [`StepResult::Failed`], and `"concern"` (case-insensitive) →
/// [`StepResult::Concern`] with an optional `summary` field. Any other value or
/// an absent/null `result`/`verdict` field returns `None`.
pub fn parse_verdict_from_value(value: &serde_json::Value) -> Option<StepResult> {
    let payload: VerdictPayload = serde_json::from_value(value.clone()).ok()?;
    result_from_payload(&payload)
}

pub fn parse_step_output_from_value(value: &serde_json::Value) -> Option<StepOutput> {
    let payload: VerdictPayload = serde_json::from_value(value.clone()).ok()?;
    step_output_from_payload(&payload)
}

/// Read `.ensemble/verdict-{step_name}.json` from the given workspace directory.
///
/// Returns `Ok(None)` if the file does not exist. Returns `Ok(Some(verdict))`
/// if the file exists and parses successfully. Returns an `Err` only on
/// unexpected I/O failures (not "file not found").
pub async fn read_verdict_file(
    workspace: &Path,
    step_name: &str,
) -> Result<Option<StepResult>, std::io::Error> {
    read_step_output_file(workspace, step_name)
        .await
        .map(|value| value.map(|output| output.result))
}

pub async fn read_step_output_file(
    workspace: &Path,
    step_name: &str,
) -> Result<Option<StepOutput>, std::io::Error> {
    let step_file = workspace
        .join(".ensemble")
        .join(format!("verdict-{step_name}.json"));
    let legacy_file = workspace.join(".ensemble").join("verdict.json");

    // Try step-scoped file first, fall back to legacy verdict.json.
    for path in [&step_file, &legacy_file] {
        match tokio::fs::read_to_string(path).await {
            Ok(contents) => {
                let payload: VerdictPayload = serde_json::from_str(&contents)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                return Ok(step_output_from_payload(&payload));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

/// Resolve the final verdict for a completed step.
///
/// Priority:
/// 1. ACP event value (`acp_verdict`) — checked first.
/// 2. `.ensemble/verdict-{step_name}.json` in the workspace — checked if ACP yields nothing.
/// 3. `.ensemble/verdict.json` (legacy fallback) — checked if step-scoped file is absent.
/// 4. Default to [`StepResult::Succeeded`] if no source provides a verdict.
pub async fn resolve_verdict(
    acp_verdict: Option<&serde_json::Value>,
    workspace: &Path,
    step_name: &str,
) -> StepResult {
    resolve_verdict_with_source(acp_verdict, workspace, step_name)
        .await
        .result
}

/// Resolve the final verdict for a completed step, including the source.
pub async fn resolve_verdict_with_source(
    acp_verdict: Option<&serde_json::Value>,
    workspace: &Path,
    step_name: &str,
) -> ResolvedResult {
    // 1. Try ACP event.
    if let Some(value) = acp_verdict {
        if let Some(output) = parse_step_output_from_value(value) {
            return ResolvedResult {
                result: output.result.clone(),
                output,
                source: VerdictSource::Runtime,
            };
        }
    }

    // 2. Try file.
    match read_step_output_file(workspace, step_name).await {
        Ok(Some(output)) => {
            return ResolvedResult {
                result: output.result.clone(),
                output,
                source: VerdictSource::File,
            };
        }
        Ok(None) => {} // file doesn't exist — fall through to default
        Err(e) => {
            // Malformed verdict file — treat as rejection, not silent approval.
            let msg = format!("failed to parse .ensemble/verdict-{step_name}.json: {e}");
            let failed = StepResult::Failed {
                summary: msg.clone(),
            };
            let output = StepOutput {
                result: failed.clone(),
                summary: Some(msg),
                output: None,
            };
            return ResolvedResult {
                result: failed,
                output,
                source: VerdictSource::File,
            };
        }
    }

    // 3. Default (no ACP verdict, no file).
    warn!("no verdict source found for step, defaulting to Succeeded");
    let output = StepOutput {
        result: StepResult::Succeeded,
        summary: None,
        output: None,
    };
    ResolvedResult {
        result: output.result.clone(),
        output,
        source: VerdictSource::Default,
    }
}

/// Convert a [`VerdictPayload`] into an `Option<StepResult>`.
fn result_from_payload(payload: &VerdictPayload) -> Option<StepResult> {
    step_output_from_payload(payload).map(|output| output.result)
}

fn step_output_from_payload(payload: &VerdictPayload) -> Option<StepOutput> {
    let result_value = payload.result.as_deref().or(payload.verdict.as_deref());
    let result = match result_value {
        Some(v) if v.eq_ignore_ascii_case("approve") || v.eq_ignore_ascii_case("succeeded") => {
            StepResult::Succeeded
        }
        Some(v) if v.eq_ignore_ascii_case("reject") || v.eq_ignore_ascii_case("failed") => {
            StepResult::Failed {
                summary: payload.summary.clone().unwrap_or_default(),
            }
        }
        Some(v) if v.eq_ignore_ascii_case("concern") => StepResult::Concern {
            summary: payload.summary.clone().unwrap_or_default(),
        },
        _ => return None,
    };

    Some(StepOutput {
        result,
        summary: payload.summary.clone(),
        output: payload.output.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    // -------------------------------------------------------------------------
    // parse_verdict_from_value
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_succeeded_result() {
        let value = json!({ "result": "succeeded" });
        assert_eq!(
            parse_verdict_from_value(&value),
            Some(StepResult::Succeeded)
        );
    }

    #[test]
    fn test_parse_legacy_approve_verdict() {
        let value = json!({ "verdict": "approve" });
        assert_eq!(
            parse_verdict_from_value(&value),
            Some(StepResult::Succeeded)
        );
    }

    #[test]
    fn test_parse_failed_result() {
        let value = json!({ "result": "failed", "summary": "tests failed" });
        assert_eq!(
            parse_verdict_from_value(&value),
            Some(StepResult::Failed {
                summary: "tests failed".to_string()
            })
        );
    }

    #[test]
    fn test_parse_legacy_reject_verdict() {
        let value = json!({ "verdict": "reject", "summary": "tests failed" });
        assert_eq!(
            parse_verdict_from_value(&value),
            Some(StepResult::Failed {
                summary: "tests failed".to_string()
            })
        );
    }

    #[test]
    fn test_parse_concern() {
        let value = json!({ "result": "concern", "summary": "needs review" });
        assert_eq!(
            parse_verdict_from_value(&value),
            Some(StepResult::Concern {
                summary: "needs review".to_string()
            })
        );
    }

    #[test]
    fn test_parse_result_preferred_over_legacy_verdict() {
        let value = json!({
            "result": "succeeded",
            "verdict": "reject",
            "summary": "legacy value should be ignored"
        });
        assert_eq!(
            parse_verdict_from_value(&value),
            Some(StepResult::Succeeded)
        );
    }

    #[test]
    fn test_parse_no_verdict_field() {
        let value = json!({ "other_key": "something" });
        assert_eq!(parse_verdict_from_value(&value), None);
    }

    #[test]
    fn test_parse_null_verdict() {
        let value = json!({ "verdict": null });
        assert_eq!(parse_verdict_from_value(&value), None);
    }

    // -------------------------------------------------------------------------
    // read_verdict_file
    // -------------------------------------------------------------------------

    async fn write_verdict_file(dir: &TempDir, contents: &str) {
        write_step_verdict_file(dir, "build", contents).await;
    }

    async fn write_step_verdict_file(dir: &TempDir, step_name: &str, contents: &str) {
        let ensemble_dir = dir.path().join(".ensemble");
        tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
        let filename = format!("verdict-{step_name}.json");
        tokio::fs::write(ensemble_dir.join(&filename), contents)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_read_verdict_file_approve() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"approve"}"#).await;
        let result = read_verdict_file(dir.path(), "build").await.unwrap();
        assert_eq!(result, Some(StepResult::Succeeded));
    }

    #[tokio::test]
    async fn test_read_verdict_file_reject() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"reject","summary":"lint errors"}"#).await;
        let result = read_verdict_file(dir.path(), "build").await.unwrap();
        assert_eq!(
            result,
            Some(StepResult::Failed {
                summary: "lint errors".to_string()
            })
        );
    }

    #[tokio::test]
    async fn test_read_verdict_file_missing() {
        let dir = TempDir::new().unwrap();
        let result = read_verdict_file(dir.path(), "build").await.unwrap();
        assert_eq!(result, None);
    }

    // -------------------------------------------------------------------------
    // resolve_verdict
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn test_resolve_verdict_acp_takes_priority() {
        // ACP says approve, file says reject — ACP wins.
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"reject","summary":"broken"}"#).await;

        let acp = json!({ "result": "succeeded" });
        let result = resolve_verdict(Some(&acp), dir.path(), "build").await;
        assert_eq!(result, StepResult::Succeeded);
    }

    #[tokio::test]
    async fn test_resolve_verdict_with_source_runtime_takes_priority() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"reject","summary":"broken"}"#).await;

        let acp = json!({ "result": "succeeded" });
        let result = resolve_verdict_with_source(Some(&acp), dir.path(), "build").await;
        assert_eq!(result.result, StepResult::Succeeded);
        assert_eq!(result.source, VerdictSource::Runtime);
    }

    #[tokio::test]
    async fn test_resolve_verdict_falls_back_to_file() {
        // No ACP value — file provides the verdict.
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"reject","summary":"compile error"}"#).await;

        let result = resolve_verdict(None, dir.path(), "build").await;
        assert_eq!(
            result,
            StepResult::Failed {
                summary: "compile error".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_resolve_verdict_with_source_falls_back_to_file() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"reject","summary":"compile error"}"#).await;

        let result = resolve_verdict_with_source(None, dir.path(), "build").await;
        assert_eq!(
            result.result,
            StepResult::Failed {
                summary: "compile error".to_string()
            }
        );
        assert_eq!(result.source, VerdictSource::File);
    }

    #[tokio::test]
    async fn test_resolve_verdict_no_source_is_approve() {
        // No ACP, no file — defaults to Approve.
        let dir = TempDir::new().unwrap();
        let result = resolve_verdict(None, dir.path(), "build").await;
        assert_eq!(result, StepResult::Succeeded);
    }

    #[tokio::test]
    async fn test_resolve_verdict_with_source_no_source_is_default_approve() {
        let dir = TempDir::new().unwrap();
        let result = resolve_verdict_with_source(None, dir.path(), "build").await;
        assert_eq!(result.result, StepResult::Succeeded);
        assert_eq!(result.source, VerdictSource::Default);
    }

    #[tokio::test]
    async fn test_read_verdict_file_malformed_json_is_error() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, "this is not json").await;
        let result = read_verdict_file(dir.path(), "build").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_resolve_verdict_malformed_file_rejects() {
        // Malformed verdict.json should reject, not silently approve.
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, "not valid json").await;
        let result = resolve_verdict(None, dir.path(), "build").await;
        assert!(matches!(result, StepResult::Failed { .. }));
    }

    // -------------------------------------------------------------------------
    // StepOutput and parse_step_output_from_value
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_step_output_from_runtime_value() {
        let value = json!({
            "result": "succeeded",
            "summary": "review passed",
            "output": {"risk": "low", "findings": []}
        });

        let output = parse_step_output_from_value(&value).unwrap();

        assert_eq!(output.result, StepResult::Succeeded);
        assert_eq!(output.summary.as_deref(), Some("review passed"));
        assert_eq!(output.output, Some(json!({"risk":"low","findings":[]})));
    }

    #[tokio::test]
    async fn test_read_step_output_file_preserves_approve_summary_and_output() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(
            &dir,
            r#"{"verdict":"approve","summary":"ok","output":{"files":["src/lib.rs"]}}"#,
        )
        .await;

        let output = read_step_output_file(dir.path(), "build")
            .await
            .unwrap()
            .unwrap();

        assert_eq!(output.result, StepResult::Succeeded);
        assert_eq!(output.summary.as_deref(), Some("ok"));
        assert_eq!(output.output, Some(json!({"files":["src/lib.rs"]})));
    }
}
