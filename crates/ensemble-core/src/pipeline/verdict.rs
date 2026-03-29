use std::path::Path;

use serde::Deserialize;

/// The verdict returned by a review agent at the end of a pipeline step.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// The step output is accepted; continue to the next step or mark success.
    Approve,
    /// The step output is rejected; retry or mark failure.
    Reject { summary: String },
}

/// Internal deserialization type for both ACP JSON values and verdict files.
#[derive(Debug, Deserialize)]
struct VerdictPayload {
    verdict: Option<String>,
    summary: Option<String>,
}

/// Parse a [`Verdict`] from an arbitrary JSON value (e.g. an ACP event body).
///
/// Recognises `"approve"` (case-insensitive) → [`Verdict::Approve`] and
/// `"reject"` (case-insensitive) → [`Verdict::Reject`] with an optional
/// `summary` field. Any other value or an absent/null `verdict` field returns
/// `None`.
pub fn parse_verdict_from_value(value: &serde_json::Value) -> Option<Verdict> {
    let payload: VerdictPayload = serde_json::from_value(value.clone()).ok()?;
    verdict_from_payload(&payload)
}

/// Read `.ensemble/verdict.json` from the given workspace directory.
///
/// Returns `Ok(None)` if the file does not exist. Returns `Ok(Some(verdict))`
/// if the file exists and parses successfully. Returns an `Err` only on
/// unexpected I/O failures (not "file not found").
pub async fn read_verdict_file(workspace: &Path) -> Result<Option<Verdict>, std::io::Error> {
    let path = workspace.join(".ensemble").join("verdict.json");
    match tokio::fs::read_to_string(&path).await {
        Ok(contents) => {
            let payload: VerdictPayload = serde_json::from_str(&contents)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            Ok(verdict_from_payload(&payload))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Resolve the final verdict for a completed step.
///
/// Priority:
/// 1. ACP event value (`acp_verdict`) — checked first.
/// 2. `.ensemble/verdict.json` in the workspace — checked if ACP yields nothing.
/// 3. Default to [`Verdict::Approve`] if neither source provides a verdict.
pub async fn resolve_verdict(acp_verdict: Option<&serde_json::Value>, workspace: &Path) -> Verdict {
    // 1. Try ACP event.
    if let Some(value) = acp_verdict {
        if let Some(v) = parse_verdict_from_value(value) {
            return v;
        }
    }

    // 2. Try file.
    match read_verdict_file(workspace).await {
        Ok(Some(v)) => return v,
        Ok(None) => {} // file doesn't exist — fall through to default
        Err(e) => {
            // Malformed verdict file — treat as rejection, not silent approval.
            return Verdict::Reject {
                summary: format!("failed to parse .ensemble/verdict.json: {e}"),
            };
        }
    }

    // 3. Default (no ACP verdict, no file).
    Verdict::Approve
}

/// Convert a [`VerdictPayload`] into an `Option<Verdict>`.
fn verdict_from_payload(payload: &VerdictPayload) -> Option<Verdict> {
    match payload.verdict.as_deref() {
        Some(v) if v.eq_ignore_ascii_case("approve") => Some(Verdict::Approve),
        Some(v) if v.eq_ignore_ascii_case("reject") => Some(Verdict::Reject {
            summary: payload.summary.clone().unwrap_or_default(),
        }),
        _ => None,
    }
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
    fn test_parse_approve() {
        let value = json!({ "verdict": "approve" });
        assert_eq!(parse_verdict_from_value(&value), Some(Verdict::Approve));
    }

    #[test]
    fn test_parse_reject() {
        let value = json!({ "verdict": "reject", "summary": "tests failed" });
        assert_eq!(
            parse_verdict_from_value(&value),
            Some(Verdict::Reject {
                summary: "tests failed".to_string()
            })
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
        let ensemble_dir = dir.path().join(".ensemble");
        tokio::fs::create_dir_all(&ensemble_dir).await.unwrap();
        tokio::fs::write(ensemble_dir.join("verdict.json"), contents)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_read_verdict_file_approve() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"approve"}"#).await;
        let result = read_verdict_file(dir.path()).await.unwrap();
        assert_eq!(result, Some(Verdict::Approve));
    }

    #[tokio::test]
    async fn test_read_verdict_file_reject() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"reject","summary":"lint errors"}"#).await;
        let result = read_verdict_file(dir.path()).await.unwrap();
        assert_eq!(
            result,
            Some(Verdict::Reject {
                summary: "lint errors".to_string()
            })
        );
    }

    #[tokio::test]
    async fn test_read_verdict_file_missing() {
        let dir = TempDir::new().unwrap();
        let result = read_verdict_file(dir.path()).await.unwrap();
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

        let acp = json!({ "verdict": "approve" });
        let result = resolve_verdict(Some(&acp), dir.path()).await;
        assert_eq!(result, Verdict::Approve);
    }

    #[tokio::test]
    async fn test_resolve_verdict_falls_back_to_file() {
        // No ACP value — file provides the verdict.
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, r#"{"verdict":"reject","summary":"compile error"}"#).await;

        let result = resolve_verdict(None, dir.path()).await;
        assert_eq!(
            result,
            Verdict::Reject {
                summary: "compile error".to_string()
            }
        );
    }

    #[tokio::test]
    async fn test_resolve_verdict_no_source_is_approve() {
        // No ACP, no file — defaults to Approve.
        let dir = TempDir::new().unwrap();
        let result = resolve_verdict(None, dir.path()).await;
        assert_eq!(result, Verdict::Approve);
    }

    #[tokio::test]
    async fn test_read_verdict_file_malformed_json_is_error() {
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, "this is not json").await;
        let result = read_verdict_file(dir.path()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_resolve_verdict_malformed_file_rejects() {
        // Malformed verdict.json should reject, not silently approve.
        let dir = TempDir::new().unwrap();
        write_verdict_file(&dir, "not valid json").await;
        let result = resolve_verdict(None, dir.path()).await;
        assert!(matches!(result, Verdict::Reject { .. }));
    }
}
