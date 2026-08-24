use std::path::{Path, PathBuf};

use ensemble_core::config::ensemble::{
    load_config, validate_config, ArtifactAccess, StepActionConfig, StepKind,
};
use ensemble_core::pipeline::verdict::{StepOutput, StepResult};

fn example_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/examples/outcome-routing")
}

fn read_json(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn outcome_routing_example_uses_only_generic_pipeline_contracts() {
    let root = example_root();
    let config = load_config(&root.join("config.yaml")).unwrap();
    validate_config(&config).unwrap();

    let producer = config
        .steps
        .iter()
        .find(|step| step.name == "produce")
        .unwrap();
    assert_eq!(producer.actions.len(), 2);
    assert!(matches!(
        producer.actions[0],
        StepActionConfig::TrackerComment { .. }
    ));
    assert!(matches!(
        producer.actions[1],
        StepActionConfig::OperatorAttention { .. }
    ));
    assert!(producer.artifact_snapshot.is_some());

    let route = config
        .steps
        .iter()
        .find(|step| step.name == "choose_outcome")
        .unwrap();
    assert_eq!(route.kind, StepKind::Route);
    assert_eq!(
        route
            .route
            .as_ref()
            .unwrap()
            .cases
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["operator_required", "revised_artifact"]
    );
    assert!(route.actions.is_empty());

    let protected = config
        .steps
        .iter()
        .find(|step| step.name == "publish_revision")
        .unwrap();
    assert_eq!(protected.artifact_inputs, ["produce"]);
    assert_eq!(protected.artifact_access, ArtifactAccess::Immutable);
    assert!(protected.authorization.is_some());

    let schema = read_json(&root.join("schemas/outcome.schema.json"));
    let validator = jsonschema::validator_for(&schema).unwrap();
    for output in ["revised-artifact.json", "operator-required.json"] {
        let output = read_json(&root.join("outputs").join(output));
        assert!(validator.is_valid(&output));
        let step_output = StepOutput {
            result: StepResult::Succeeded,
            summary: None,
            output: Some(output),
        };
        assert!(step_output.output.is_some());
    }

    let guide = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/outcome-routing.md"),
    )
    .unwrap();
    assert!(guide.contains("examples/outcome-routing/config.yaml"));
    assert!(guide.contains("whole Run"));
}
