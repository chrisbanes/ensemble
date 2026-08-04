use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceStatus {
    Passed,
    Failed,
    TimedOut,
    Unavailable,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcceptanceTiming {
    Observed {
        started_at: DateTime<Utc>,
        completed_at: DateTime<Utc>,
        duration_ms: u64,
    },
    #[default]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AcceptanceOutput {
    pub tail: String,
    pub total_bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AcceptanceResult {
    pub name: String,
    pub status: AcceptanceStatus,
    #[serde(default)]
    pub timing: AcceptanceTiming,
    pub exit_code: Option<i32>,
    pub stdout: AcceptanceOutput,
    pub stderr: AcceptanceOutput,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AcceptanceAttempt {
    pub cycle: u32,
    pub results: Vec<AcceptanceResult>,
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use super::*;

    #[test]
    fn legacy_result_defaults_timing_to_unknown() {
        let value = serde_json::json!({
            "name": "tests",
            "status": "passed",
            "exit_code": 0,
            "stdout": {"tail": "ok", "total_bytes": 2, "truncated": false},
            "stderr": {"tail": "", "total_bytes": 0, "truncated": false},
            "summary": "acceptance command 'tests' passed"
        });

        let result: AcceptanceResult = serde_json::from_value(value).unwrap();

        assert_eq!(result.timing, AcceptanceTiming::Unknown);
    }

    #[test]
    fn observed_timing_uses_the_tagged_wire_shape() {
        let timing = AcceptanceTiming::Observed {
            started_at: Utc.with_ymd_and_hms(2026, 8, 4, 9, 0, 0).unwrap(),
            completed_at: Utc.with_ymd_and_hms(2026, 8, 4, 9, 0, 1).unwrap(),
            duration_ms: 1_234,
        };

        assert_eq!(
            serde_json::to_value(timing).unwrap(),
            serde_json::json!({
                "kind": "observed",
                "started_at": "2026-08-04T09:00:00Z",
                "completed_at": "2026-08-04T09:00:01Z",
                "duration_ms": 1234
            })
        );
    }
}
