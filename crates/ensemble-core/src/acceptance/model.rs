use chrono::{DateTime, Utc};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::config::ensemble::{
    AcceptanceFileConfig, AcceptanceHandoffConfig, AcceptancePullRequestConfig, EnsembleConfig,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
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
#[serde(rename_all = "snake_case")]
pub enum FileObservation {
    Present,
    Missing,
    NotRegularFile,
    OutsideRepository,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum JsonValueKind {
    Null,
    Boolean,
    Number,
    String,
    Array,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HandoffOutputObservation {
    Object,
    Missing,
    NonObject { value_kind: JsonValueKind },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HandoffSectionObservation {
    Present,
    Missing,
    Null,
    BlankString,
    EmptyObject,
    EmptyArray,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct HandoffSectionEvidence {
    pub name: String,
    pub observation: HandoffSectionObservation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestDeliveryPhase {
    Prepared,
    PushInFlight,
    ReconcilingPush,
    PrCreateInFlight,
    ReconcilingPr,
    Waiting,
    Published,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcceptanceEvidence {
    Command {
        exit_code: Option<i32>,
        stdout: AcceptanceOutput,
        stderr: AcceptanceOutput,
    },
    File {
        repo: String,
        path: String,
        observation: FileObservation,
    },
    Handoff {
        step: String,
        output: HandoffOutputObservation,
        sections: Vec<HandoffSectionEvidence>,
    },
    PullRequest {
        repo: String,
        delivery_phase: PullRequestDeliveryPhase,
        base_branch: Option<String>,
        head_branch: Option<String>,
        head_sha: Option<String>,
        pr_number: Option<u64>,
        pr_url: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct AcceptanceResult {
    version: u8,
    pub name: String,
    pub status: AcceptanceStatus,
    pub summary: String,
    #[serde(default)]
    pub timing: AcceptanceTiming,
    pub evidence: AcceptanceEvidence,
}

impl AcceptanceResult {
    pub const VERSION: u8 = 2;

    pub fn new(
        name: String,
        status: AcceptanceStatus,
        summary: String,
        evidence: AcceptanceEvidence,
    ) -> Self {
        Self {
            version: Self::VERSION,
            name,
            status,
            summary,
            timing: AcceptanceTiming::Unknown,
            evidence,
        }
    }

    pub fn version(&self) -> u8 {
        self.version
    }

    pub(crate) fn command(
        name: String,
        status: AcceptanceStatus,
        summary: String,
        exit_code: Option<i32>,
        stdout: AcceptanceOutput,
        stderr: AcceptanceOutput,
    ) -> Self {
        Self::new(
            name,
            status,
            summary,
            AcceptanceEvidence::Command {
                exit_code,
                stdout,
                stderr,
            },
        )
    }
}

#[derive(Deserialize)]
struct AcceptanceResultWire {
    version: Option<u8>,
    name: String,
    status: AcceptanceStatus,
    summary: String,
    #[serde(default)]
    timing: AcceptanceTiming,
    evidence: Option<AcceptanceEvidence>,
    #[serde(default, deserialize_with = "deserialize_present")]
    exit_code: Present<i32>,
    #[serde(default, deserialize_with = "deserialize_present")]
    stdout: Present<AcceptanceOutput>,
    #[serde(default, deserialize_with = "deserialize_present")]
    stderr: Present<AcceptanceOutput>,
}

struct Present<T> {
    value: Option<T>,
    present: bool,
}

impl<T> Default for Present<T> {
    fn default() -> Self {
        Self {
            value: None,
            present: false,
        }
    }
}

fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Present<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Present {
        value: Option::<T>::deserialize(deserializer)?,
        present: true,
    })
}

impl<'de> Deserialize<'de> for AcceptanceResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = AcceptanceResultWire::deserialize(deserializer)?;
        let evidence = match wire.version {
            Some(Self::VERSION) => {
                if wire.exit_code.present || wire.stdout.present || wire.stderr.present {
                    return Err(D::Error::custom(
                        "version 2 acceptance result must not contain legacy command fields",
                    ));
                }
                wire.evidence.ok_or_else(|| {
                    D::Error::custom("version 2 acceptance result is missing evidence")
                })?
            }
            Some(version) => {
                return Err(D::Error::custom(format!(
                    "unsupported acceptance result version {version}"
                )));
            }
            None => {
                if wire.evidence.is_some() {
                    return Err(D::Error::custom(
                        "unversioned acceptance result must use legacy flat command fields",
                    ));
                }
                AcceptanceEvidence::Command {
                    exit_code: wire.exit_code.value,
                    stdout: wire.stdout.value.ok_or_else(|| {
                        D::Error::custom("legacy acceptance result is missing stdout")
                    })?,
                    stderr: wire.stderr.value.ok_or_else(|| {
                        D::Error::custom("legacy acceptance result is missing stderr")
                    })?,
                }
            }
        };
        Ok(Self {
            version: Self::VERSION,
            name: wire.name,
            status: wire.status,
            summary: wire.summary,
            timing: wire.timing,
            evidence,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AcceptanceAttempt {
    pub cycle: u32,
    pub results: Vec<AcceptanceResult>,
}

/// Non-secret acceptance descriptors frozen with a run before acceptance begins.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedAcceptancePlan {
    pub config_digest: String,
    pub commands: Vec<String>,
    pub required_files: Vec<AcceptanceFileConfig>,
    pub required_handoff_sections: Vec<AcceptanceHandoffConfig>,
    pub required_pull_requests: Vec<AcceptancePullRequestConfig>,
}

impl ResolvedAcceptancePlan {
    pub fn from_config(config: &EnsembleConfig) -> Result<Self, serde_json::Error> {
        Ok(Self {
            config_digest: semantic_config_digest(config)?,
            commands: config
                .acceptance
                .commands
                .iter()
                .map(|command| command.name.clone())
                .collect(),
            required_files: config.acceptance.required_files.clone(),
            required_handoff_sections: config.acceptance.required_handoff_sections.clone(),
            required_pull_requests: config.acceptance.required_pull_requests.clone(),
        })
    }

    pub fn matches_config(&self, config: &EnsembleConfig) -> bool {
        semantic_config_digest(config).is_ok_and(|digest| digest == self.config_digest)
    }

    pub fn pre_final_len(&self) -> usize {
        self.commands.len() + self.required_files.len() + self.required_handoff_sections.len()
    }
}

fn semantic_config_digest(config: &EnsembleConfig) -> Result<String, serde_json::Error> {
    fn canonicalize(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(canonicalize).collect())
            }
            serde_json::Value::Object(values) => {
                let sorted = values
                    .into_iter()
                    .map(|(key, value)| (key, canonicalize(value)))
                    .collect::<std::collections::BTreeMap<_, _>>();
                serde_json::Value::Object(sorted.into_iter().collect())
            }
            value => value,
        }
    }

    let value = canonicalize(serde_json::to_value(config)?);
    let bytes = serde_json::to_vec(&value)?;
    Ok(hex::encode(Sha256::digest(bytes)))
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
        assert_eq!(
            result.evidence,
            AcceptanceEvidence::Command {
                exit_code: Some(0),
                stdout: AcceptanceOutput {
                    tail: "ok".to_string(),
                    total_bytes: 2,
                    truncated: false,
                },
                stderr: AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
            }
        );
        assert_eq!(serde_json::to_value(result).unwrap()["version"], 2);
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

    #[test]
    fn version_two_serializes_each_typed_evidence_variant() {
        let cases = [
            (
                AcceptanceEvidence::Command {
                    exit_code: Some(0),
                    stdout: AcceptanceOutput {
                        tail: "ok".into(),
                        total_bytes: 2,
                        truncated: false,
                    },
                    stderr: AcceptanceOutput {
                        tail: String::new(),
                        total_bytes: 0,
                        truncated: false,
                    },
                },
                serde_json::json!({
                    "kind": "command",
                    "exit_code": 0,
                    "stdout": {"tail": "ok", "total_bytes": 2, "truncated": false},
                    "stderr": {"tail": "", "total_bytes": 0, "truncated": false}
                }),
            ),
            (
                AcceptanceEvidence::File {
                    repo: "ensemble".into(),
                    path: "docs/release.md".into(),
                    observation: FileObservation::Present,
                },
                serde_json::json!({
                    "kind": "file",
                    "repo": "ensemble",
                    "path": "docs/release.md",
                    "observation": "present"
                }),
            ),
            (
                AcceptanceEvidence::Handoff {
                    step: "synthesize".into(),
                    output: HandoffOutputObservation::Object,
                    sections: vec![HandoffSectionEvidence {
                        name: "summary".into(),
                        observation: HandoffSectionObservation::Present,
                    }],
                },
                serde_json::json!({
                    "kind": "handoff",
                    "step": "synthesize",
                    "output": {"kind": "object"},
                    "sections": [{"name": "summary", "observation": "present"}]
                }),
            ),
            (
                AcceptanceEvidence::PullRequest {
                    repo: "ensemble".into(),
                    delivery_phase: PullRequestDeliveryPhase::Blocked,
                    base_branch: None,
                    head_branch: Some("issue-418".into()),
                    head_sha: None,
                    pr_number: None,
                    pr_url: None,
                },
                serde_json::json!({
                    "kind": "pull_request",
                    "repo": "ensemble",
                    "delivery_phase": "blocked",
                    "base_branch": null,
                    "head_branch": "issue-418",
                    "head_sha": null,
                    "pr_number": null,
                    "pr_url": null
                }),
            ),
        ];

        for (evidence, expected_evidence) in cases {
            let result = AcceptanceResult::new(
                "rule".into(),
                AcceptanceStatus::Failed,
                "precise reason".into(),
                evidence,
            );
            let value = serde_json::to_value(&result).unwrap();
            assert_eq!(value["version"], 2);
            assert_eq!(value["evidence"], expected_evidence);
            assert!(value.get("exit_code").is_none());
            assert_eq!(
                serde_json::from_value::<AcceptanceResult>(value).unwrap(),
                result
            );
        }
    }

    #[test]
    fn unsupported_explicit_version_fails_closed() {
        let error = serde_json::from_value::<AcceptanceResult>(serde_json::json!({
            "version": 3,
            "name": "future",
            "status": "passed",
            "summary": "future",
            "timing": {"kind": "unknown"},
            "evidence": {
                "kind": "file",
                "repo": "ensemble",
                "path": "README.md",
                "observation": "present"
            }
        }))
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("unsupported acceptance result version 3"));
    }

    #[test]
    fn version_two_rejects_legacy_fields_even_when_null() {
        for field in ["exit_code", "stdout", "stderr"] {
            let mut value = serde_json::json!({
                "version": 2,
                "name": "rule",
                "status": "passed",
                "summary": "passed",
                "timing": {"kind": "unknown"},
                "evidence": {
                    "kind": "file",
                    "repo": "ensemble",
                    "path": "README.md",
                    "observation": "present"
                }
            });
            value[field] = serde_json::Value::Null;

            let error = serde_json::from_value::<AcceptanceResult>(value).unwrap_err();

            assert!(
                error
                    .to_string()
                    .contains("version 2 acceptance result must not contain legacy command fields"),
                "unexpected error for {field}: {error}"
            );
        }
    }
}
