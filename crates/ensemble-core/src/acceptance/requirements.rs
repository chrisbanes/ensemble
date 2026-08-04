use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::PathBuf;

use crate::acceptance::{
    AcceptanceEvidence, AcceptanceResult, AcceptanceStatus, FileObservation,
    HandoffOutputObservation, HandoffSectionEvidence, HandoffSectionObservation, JsonValueKind,
};
use crate::config::ensemble::{AcceptanceFileConfig, AcceptanceHandoffConfig};
use crate::pipeline::verdict::StepOutput;

use super::runner::AcceptanceTimer;

pub(crate) fn evaluate_file_requirement(
    rule: &AcceptanceFileConfig,
    worktrees: &HashMap<String, PathBuf>,
) -> AcceptanceResult {
    let timer = AcceptanceTimer::start();
    let (status, observation, summary) = match worktrees.get(&rule.repo) {
        None => (
            AcceptanceStatus::Unavailable,
            FileObservation::Unavailable,
            format!(
                "required file '{}' is unavailable because repository '{}' has no owned worktree",
                rule.name, rule.repo
            ),
        ),
        Some(root) => evaluate_file_path(rule, root),
    };
    timer.finish(AcceptanceResult::new(
        rule.name.clone(),
        status,
        summary,
        AcceptanceEvidence::File {
            repo: rule.repo.clone(),
            path: rule.path.to_string_lossy().into_owned(),
            observation,
        },
    ))
}

fn evaluate_file_path(
    rule: &AcceptanceFileConfig,
    root: &std::path::Path,
) -> (AcceptanceStatus, FileObservation, String) {
    let canonical_root = match std::fs::canonicalize(root) {
        Ok(root) => root,
        Err(error) => {
            return (
                AcceptanceStatus::Unavailable,
                FileObservation::Unavailable,
                format!(
                    "required file '{}' is unavailable because repository '{}' worktree cannot be resolved: {error}",
                    rule.name, rule.repo
                ),
            );
        }
    };
    let target = root.join(&rule.path);
    let canonical_target = match std::fs::canonicalize(&target) {
        Ok(path) => path,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return (
                AcceptanceStatus::Failed,
                FileObservation::Missing,
                format!(
                    "required file '{}' is missing at '{}' in repository '{}'",
                    rule.name,
                    rule.path.display(),
                    rule.repo
                ),
            );
        }
        Err(error) => {
            return (
                AcceptanceStatus::Unavailable,
                FileObservation::Unavailable,
                format!(
                    "required file '{}' could not be inspected in repository '{}': {error}",
                    rule.name, rule.repo
                ),
            );
        }
    };
    if !canonical_target.starts_with(&canonical_root) {
        return (
            AcceptanceStatus::Failed,
            FileObservation::OutsideRepository,
            format!(
                "required file '{}' at '{}' resolves outside repository '{}'",
                rule.name,
                rule.path.display(),
                rule.repo
            ),
        );
    }
    match std::fs::metadata(&canonical_target) {
        Ok(metadata) if metadata.is_file() => (
            AcceptanceStatus::Passed,
            FileObservation::Present,
            format!(
                "required file '{}' is present at '{}' in repository '{}'",
                rule.name,
                rule.path.display(),
                rule.repo
            ),
        ),
        Ok(_) => (
            AcceptanceStatus::Failed,
            FileObservation::NotRegularFile,
            format!(
                "required file '{}' at '{}' in repository '{}' is not a regular file",
                rule.name,
                rule.path.display(),
                rule.repo
            ),
        ),
        Err(error) => (
            AcceptanceStatus::Unavailable,
            FileObservation::Unavailable,
            format!(
                "required file '{}' could not be inspected in repository '{}': {error}",
                rule.name, rule.repo
            ),
        ),
    }
}

pub(crate) fn evaluate_handoff_requirement(
    rule: &AcceptanceHandoffConfig,
    step_outputs: &HashMap<String, StepOutput>,
) -> AcceptanceResult {
    let timer = AcceptanceTimer::start();
    let (status, output, sections, summary) = match step_outputs
        .get(&rule.step)
        .and_then(|step_output| step_output.output.as_ref())
    {
        None => (
            AcceptanceStatus::Failed,
            HandoffOutputObservation::Missing,
            Vec::new(),
            format!(
                "required handoff '{}' has no persisted output for step '{}'",
                rule.name, rule.step
            ),
        ),
        Some(serde_json::Value::Object(object)) => {
            let sections = rule
                .sections
                .iter()
                .map(|name| HandoffSectionEvidence {
                    name: name.clone(),
                    observation: section_observation(object.get(name)),
                })
                .collect::<Vec<_>>();
            let failed = sections
                .iter()
                .filter(|section| section.observation != HandoffSectionObservation::Present)
                .map(|section| format!("{} is {:?}", section.name, section.observation))
                .collect::<Vec<_>>();
            if failed.is_empty() {
                (
                    AcceptanceStatus::Passed,
                    HandoffOutputObservation::Object,
                    sections,
                    format!(
                        "required handoff '{}' contains every configured section",
                        rule.name
                    ),
                )
            } else {
                (
                    AcceptanceStatus::Failed,
                    HandoffOutputObservation::Object,
                    sections,
                    format!(
                        "required handoff '{}' has invalid sections: {}",
                        rule.name,
                        failed.join(", ")
                    ),
                )
            }
        }
        Some(value) => (
            AcceptanceStatus::Failed,
            HandoffOutputObservation::NonObject {
                value_kind: json_value_kind(value),
            },
            Vec::new(),
            format!(
                "required handoff '{}' step '{}' output is not an object",
                rule.name, rule.step
            ),
        ),
    };
    timer.finish(AcceptanceResult::new(
        rule.name.clone(),
        status,
        summary,
        AcceptanceEvidence::Handoff {
            step: rule.step.clone(),
            output,
            sections,
        },
    ))
}

fn section_observation(value: Option<&serde_json::Value>) -> HandoffSectionObservation {
    match value {
        None => HandoffSectionObservation::Missing,
        Some(serde_json::Value::Null) => HandoffSectionObservation::Null,
        Some(serde_json::Value::String(value)) if value.trim().is_empty() => {
            HandoffSectionObservation::BlankString
        }
        Some(serde_json::Value::Object(value)) if value.is_empty() => {
            HandoffSectionObservation::EmptyObject
        }
        Some(serde_json::Value::Array(value)) if value.is_empty() => {
            HandoffSectionObservation::EmptyArray
        }
        Some(_) => HandoffSectionObservation::Present,
    }
}

fn json_value_kind(value: &serde_json::Value) -> JsonValueKind {
    match value {
        serde_json::Value::Null => JsonValueKind::Null,
        serde_json::Value::Bool(_) => JsonValueKind::Boolean,
        serde_json::Value::Number(_) => JsonValueKind::Number,
        serde_json::Value::String(_) => JsonValueKind::String,
        serde_json::Value::Array(_) => JsonValueKind::Array,
        serde_json::Value::Object(_) => unreachable!("objects are handled before classification"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_requirement_reports_present_and_missing() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("present.txt"), "ok").unwrap();
        let worktrees = HashMap::from([("repo".to_string(), root.path().to_path_buf())]);

        let present = evaluate_file_requirement(
            &AcceptanceFileConfig {
                name: "present".into(),
                repo: "repo".into(),
                path: "present.txt".into(),
            },
            &worktrees,
        );
        let missing = evaluate_file_requirement(
            &AcceptanceFileConfig {
                name: "missing".into(),
                repo: "repo".into(),
                path: "missing.txt".into(),
            },
            &worktrees,
        );

        assert_eq!(present.status, AcceptanceStatus::Passed);
        assert!(matches!(
            present.evidence,
            AcceptanceEvidence::File {
                observation: FileObservation::Present,
                ..
            }
        ));
        assert_eq!(missing.status, AcceptanceStatus::Failed);
        assert!(matches!(
            missing.evidence,
            AcceptanceEvidence::File {
                observation: FileObservation::Missing,
                ..
            }
        ));
    }

    #[test]
    fn file_requirement_enforces_regular_file_and_worktree_boundary() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("directory")).unwrap();
        std::fs::write(root.path().join("target.txt"), "inside").unwrap();
        std::fs::write(outside.path().join("outside.txt"), "outside").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("target.txt", root.path().join("inside-link.txt")).unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("outside.txt"),
                root.path().join("outside-link.txt"),
            )
            .unwrap();
        }
        let worktrees = HashMap::from([("repo".to_string(), root.path().to_path_buf())]);

        let evaluate = |name: &str, path: &str| {
            evaluate_file_requirement(
                &AcceptanceFileConfig {
                    name: name.into(),
                    repo: "repo".into(),
                    path: path.into(),
                },
                &worktrees,
            )
        };
        assert!(matches!(
            evaluate("directory", "directory").evidence,
            AcceptanceEvidence::File {
                observation: FileObservation::NotRegularFile,
                ..
            }
        ));
        #[cfg(unix)]
        {
            assert_eq!(
                evaluate("inside", "inside-link.txt").status,
                AcceptanceStatus::Passed
            );
            let escaping = evaluate("escaping", "outside-link.txt");
            assert_eq!(escaping.status, AcceptanceStatus::Failed);
            assert!(matches!(
                escaping.evidence,
                AcceptanceEvidence::File {
                    observation: FileObservation::OutsideRepository,
                    ..
                }
            ));
            assert!(!escaping
                .summary
                .contains(&outside.path().display().to_string()));
        }
    }

    #[test]
    fn file_requirement_reports_unavailable_without_an_owned_worktree() {
        let result = evaluate_file_requirement(
            &AcceptanceFileConfig {
                name: "artifact".into(),
                repo: "repo".into(),
                path: "artifact.bin".into(),
            },
            &HashMap::new(),
        );

        assert_eq!(result.status, AcceptanceStatus::Unavailable);
        assert!(matches!(
            result.evidence,
            AcceptanceEvidence::File {
                observation: FileObservation::Unavailable,
                ..
            }
        ));
    }

    fn step_output(output: Option<serde_json::Value>) -> StepOutput {
        StepOutput {
            result: crate::pipeline::verdict::StepResult::Succeeded,
            summary: None,
            output,
        }
    }

    #[test]
    fn handoff_requirement_reports_every_section_in_configuration_order() {
        let rule = AcceptanceHandoffConfig {
            name: "handoff".into(),
            step: "synthesize".into(),
            sections: vec![
                "present_false".into(),
                "present_zero".into(),
                "missing".into(),
                "null".into(),
                "blank".into(),
                "object".into(),
                "array".into(),
            ],
        };
        let outputs = HashMap::from([(
            "synthesize".into(),
            step_output(Some(serde_json::json!({
                "present_false": false,
                "present_zero": 0,
                "null": null,
                "blank": "  ",
                "object": {},
                "array": []
            }))),
        )]);

        let result = evaluate_handoff_requirement(&rule, &outputs);

        assert_eq!(result.status, AcceptanceStatus::Failed);
        let AcceptanceEvidence::Handoff {
            output, sections, ..
        } = result.evidence
        else {
            panic!("expected handoff evidence")
        };
        assert_eq!(output, HandoffOutputObservation::Object);
        assert_eq!(
            sections,
            vec![
                HandoffSectionEvidence {
                    name: "present_false".into(),
                    observation: HandoffSectionObservation::Present,
                },
                HandoffSectionEvidence {
                    name: "present_zero".into(),
                    observation: HandoffSectionObservation::Present,
                },
                HandoffSectionEvidence {
                    name: "missing".into(),
                    observation: HandoffSectionObservation::Missing,
                },
                HandoffSectionEvidence {
                    name: "null".into(),
                    observation: HandoffSectionObservation::Null,
                },
                HandoffSectionEvidence {
                    name: "blank".into(),
                    observation: HandoffSectionObservation::BlankString,
                },
                HandoffSectionEvidence {
                    name: "object".into(),
                    observation: HandoffSectionObservation::EmptyObject,
                },
                HandoffSectionEvidence {
                    name: "array".into(),
                    observation: HandoffSectionObservation::EmptyArray,
                },
            ]
        );
    }

    #[test]
    fn handoff_requirement_distinguishes_missing_and_non_object_output() {
        let rule = AcceptanceHandoffConfig {
            name: "handoff".into(),
            step: "synthesize".into(),
            sections: vec!["summary".into()],
        };
        let missing = evaluate_handoff_requirement(&rule, &HashMap::new());
        assert!(matches!(
            missing.evidence,
            AcceptanceEvidence::Handoff {
                output: HandoffOutputObservation::Missing,
                ref sections,
                ..
            } if sections.is_empty()
        ));

        let cases = [
            (serde_json::Value::Null, JsonValueKind::Null),
            (serde_json::json!(false), JsonValueKind::Boolean),
            (serde_json::json!(0), JsonValueKind::Number),
            (serde_json::json!("text"), JsonValueKind::String),
            (serde_json::json!([]), JsonValueKind::Array),
        ];
        for (value, expected_kind) in cases {
            let outputs = HashMap::from([("synthesize".into(), step_output(Some(value)))]);
            let result = evaluate_handoff_requirement(&rule, &outputs);
            assert!(matches!(
                result.evidence,
                AcceptanceEvidence::Handoff {
                    output: HandoffOutputObservation::NonObject { value_kind },
                    ref sections,
                    ..
                } if value_kind == expected_kind && sections.is_empty()
            ));
        }
    }
}
