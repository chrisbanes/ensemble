//! Structured Assessment and adjudication evidence for deterministic gates.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::verdict::StepOutput;

/// One evaluator's structured judgment over an immutable Artifact snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Assessment {
    pub findings: Vec<Finding>,
}

/// A source-local finding. Its identifier is stable only within `source_step`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Finding {
    pub id: String,
    pub severity: FindingSeverity,
    pub summary: String,
    pub evidence: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Blocking,
    NonBlocking,
}

/// The ordinary synthesis step's complete response to all findings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Adjudication {
    pub dispositions: Vec<Disposition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Disposition {
    pub source_step: String,
    pub finding_id: String,
    pub disposition: DispositionKind,
    pub rationale: String,
    pub evidence: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DispositionKind {
    Upheld,
    Dismissed,
    Unresolved,
}

/// Durable normalized evidence retained once a gate has evaluated its inputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GateEvidence {
    pub assessments: BTreeMap<String, Assessment>,
    pub adjudication: Adjudication,
    pub outcome: GateOutcome,
    /// The authoritative human response for an initially unresolved gate.
    /// Its absence means the deterministic gate outcome has not been resolved.
    #[serde(default)]
    pub human_resolution: Option<GateHumanResolution>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GateOutcome {
    Passed,
    Failed,
    AwaitingHuman,
}

/// The durable disposition selected by an operator for an unresolved gate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct GateHumanResolution {
    pub decision: GateHumanDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GateHumanDecision {
    Approved,
    Rejected,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssessmentEnvelope {
    assessment: Assessment,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AdjudicationEnvelope {
    adjudication: Adjudication,
}

/// Parse all source outputs plus an adjudication output and prove total coverage.
pub fn evaluate_gate(
    assessment_steps: &[String],
    adjudication_step: &str,
    outputs: &BTreeMap<String, StepOutput>,
) -> Result<GateEvidence, String> {
    let mut assessments = BTreeMap::new();
    let mut finding_keys = BTreeSet::new();
    let mut blocking = BTreeSet::new();

    for step in assessment_steps {
        let output = outputs
            .get(step)
            .and_then(|output| output.output.as_ref())
            .ok_or_else(|| format!("assessment step '{step}' has no structured output"))?;
        let assessment: Assessment = serde_json::from_value::<AssessmentEnvelope>(output.clone())
            .map_err(|error| format!("assessment step '{step}' is invalid: {error}"))?
            .assessment;
        let mut local_ids = BTreeSet::new();
        for finding in &assessment.findings {
            validate_finding(finding)
                .map_err(|error| format!("assessment step '{step}': {error}"))?;
            if !local_ids.insert(finding.id.clone()) {
                return Err(format!(
                    "assessment step '{step}' has duplicate finding id '{}'",
                    finding.id
                ));
            }
            let key = (step.clone(), finding.id.clone());
            if finding.severity == FindingSeverity::Blocking {
                blocking.insert(key.clone());
            }
            finding_keys.insert(key);
        }
        assessments.insert(step.clone(), assessment);
    }

    let output = outputs
        .get(adjudication_step)
        .and_then(|output| output.output.as_ref())
        .ok_or_else(|| {
            format!("adjudication step '{adjudication_step}' has no structured output")
        })?;
    let adjudication: Adjudication = serde_json::from_value::<AdjudicationEnvelope>(output.clone())
        .map_err(|error| format!("adjudication step '{adjudication_step}' is invalid: {error}"))?
        .adjudication;

    let mut disposition_keys = BTreeSet::new();
    let mut has_unresolved = false;
    let mut has_upheld_blocking = false;
    for disposition in &adjudication.dispositions {
        validate_disposition(disposition)?;
        let key = (
            disposition.source_step.clone(),
            disposition.finding_id.clone(),
        );
        if !disposition_keys.insert(key.clone()) {
            return Err(format!(
                "adjudication has duplicate disposition for '{}:{}'",
                disposition.source_step, disposition.finding_id
            ));
        }
        if !finding_keys.contains(&key) {
            return Err(format!(
                "adjudication references unknown finding '{}:{}'",
                disposition.source_step, disposition.finding_id
            ));
        }
        has_unresolved |= disposition.disposition == DispositionKind::Unresolved;
        has_upheld_blocking |=
            disposition.disposition == DispositionKind::Upheld && blocking.contains(&key);
    }
    if disposition_keys != finding_keys {
        return Err(
            "adjudication must contain exactly one disposition for every finding".to_string(),
        );
    }

    let outcome = if has_upheld_blocking {
        GateOutcome::Failed
    } else if has_unresolved {
        GateOutcome::AwaitingHuman
    } else {
        GateOutcome::Passed
    };
    Ok(GateEvidence {
        assessments,
        adjudication,
        outcome,
        human_resolution: None,
    })
}

fn validate_finding(finding: &Finding) -> Result<(), String> {
    if finding.id.trim().is_empty() || finding.summary.trim().is_empty() {
        return Err("finding id and summary must be non-empty".to_string());
    }
    validate_evidence(&finding.evidence)
}

fn validate_disposition(disposition: &Disposition) -> Result<(), String> {
    if disposition.source_step.trim().is_empty()
        || disposition.finding_id.trim().is_empty()
        || disposition.rationale.trim().is_empty()
    {
        return Err(
            "disposition source_step, finding_id, and rationale must be non-empty".to_string(),
        );
    }
    validate_evidence(&disposition.evidence)
}

fn validate_evidence(evidence: &Value) -> Result<(), String> {
    if evidence
        .as_object()
        .is_some_and(|object| !object.is_empty())
    {
        Ok(())
    } else {
        Err("evidence must be a non-empty object".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::verdict::StepResult;
    use serde_json::json;

    fn output(value: Value) -> StepOutput {
        StepOutput {
            result: StepResult::Succeeded,
            summary: None,
            output: Some(value),
        }
    }

    fn outputs(disposition: &str, severity: &str) -> BTreeMap<String, StepOutput> {
        BTreeMap::from([
            (
                "security".to_string(),
                output(json!({"assessment": {"findings": [{
                    "id": "sql-1", "severity": severity, "summary": "Injection",
                    "evidence": {"path": "src/db.rs"}
                }]}})),
            ),
            (
                "adjudicate".to_string(),
                output(json!({"adjudication": {"dispositions": [{
                    "source_step": "security", "finding_id": "sql-1", "disposition": disposition,
                    "rationale": "Reproduced", "evidence": {"test": "fails"}
                }]}})),
            ),
        ])
    }

    #[test]
    fn blocking_upheld_fails_and_non_blocking_upheld_passes() {
        let steps = vec!["security".to_string()];
        assert_eq!(
            evaluate_gate(&steps, "adjudicate", &outputs("upheld", "blocking"))
                .unwrap()
                .outcome,
            GateOutcome::Failed
        );
        assert_eq!(
            evaluate_gate(&steps, "adjudicate", &outputs("upheld", "non_blocking"))
                .unwrap()
                .outcome,
            GateOutcome::Passed
        );
    }

    #[test]
    fn unresolved_waits_and_invalid_coverage_fails_closed() {
        let steps = vec!["security".to_string()];
        assert_eq!(
            evaluate_gate(&steps, "adjudicate", &outputs("unresolved", "blocking"))
                .unwrap()
                .outcome,
            GateOutcome::AwaitingHuman
        );
        let mut malformed = outputs("dismissed", "blocking");
        malformed.get_mut("adjudicate").unwrap().output = Some(json!({
            "adjudication": {"dispositions": []}
        }));
        assert!(evaluate_gate(&steps, "adjudicate", &malformed)
            .unwrap_err()
            .contains("exactly one"));
    }

    #[test]
    fn upheld_blocking_finding_dominates_an_unrelated_unresolved_finding() {
        let outputs = BTreeMap::from([
            (
                "security".to_string(),
                output(json!({"assessment": {"findings": [
                    {
                        "id": "sql-1", "severity": "blocking", "summary": "Injection",
                        "evidence": {"path": "src/db.rs"}
                    },
                    {
                        "id": "style-1", "severity": "non_blocking", "summary": "Style",
                        "evidence": {"path": "src/lib.rs"}
                    }
                ]}})),
            ),
            (
                "adjudicate".to_string(),
                output(json!({"adjudication": {"dispositions": [
                    {
                        "source_step": "security", "finding_id": "sql-1", "disposition": "upheld",
                        "rationale": "Reproduced", "evidence": {"test": "fails"}
                    },
                    {
                        "source_step": "security", "finding_id": "style-1", "disposition": "unresolved",
                        "rationale": "Needs discussion", "evidence": {"note": "pending"}
                    }
                ]}})),
            ),
        ]);

        assert_eq!(
            evaluate_gate(&["security".to_string()], "adjudicate", &outputs)
                .unwrap()
                .outcome,
            GateOutcome::Failed
        );
    }
}
