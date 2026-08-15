use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ensemble_core::config::ensemble::{load_config, validate_config, ArtifactAccess, StepKind};
use ensemble_core::pipeline::assessment::{evaluate_gate, GateOutcome};
use ensemble_core::pipeline::verdict::{StepOutput, StepResult};

fn example_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/examples/adversarial-reviews")
}

fn read_json(path: &Path) -> serde_json::Value {
    let contents = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    serde_json::from_str(&contents)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

fn schema_validates(schema_path: &Path, output_path: &Path) {
    let schema = read_json(schema_path);
    let output = read_json(output_path);
    let validator = jsonschema::validator_for(&schema)
        .unwrap_or_else(|error| panic!("invalid schema {}: {error}", schema_path.display()));
    assert!(
        validator.is_valid(&output),
        "{} does not validate against {}",
        output_path.display(),
        schema_path.display(),
    );
}

fn succeeded_output(path: &Path) -> StepOutput {
    StepOutput {
        result: StepResult::Succeeded,
        summary: None,
        output: Some(read_json(path)),
    }
}

#[test]
fn adversarial_review_examples_use_supported_public_contracts() {
    let examples = example_root();
    let config = load_config(&examples.join("config.yaml")).unwrap();
    validate_config(&config).unwrap();

    let producer = config
        .steps
        .iter()
        .find(|step| step.name == "produce")
        .expect("example has one producer");
    assert_eq!(
        producer
            .artifact_snapshot
            .as_ref()
            .expect("producer declares an Artifact snapshot")
            .repositories,
        ["target"]
    );

    let gate = config
        .steps
        .iter()
        .find(|step| step.name == "adversarial-gate")
        .expect("example has a deterministic gate");
    assert_eq!(gate.kind, StepKind::Gate);
    let gate_config = gate.gate.as_ref().expect("gate is configured");
    assert_eq!(
        gate_config.assessment_steps,
        ["architecture", "verification"]
    );
    assert_eq!(gate_config.adjudication_step, "synthesis");

    for assessment_name in &gate_config.assessment_steps {
        let assessment = config
            .steps
            .iter()
            .find(|step| step.name == *assessment_name)
            .expect("configured assessment step");
        assert_eq!(assessment.kind, StepKind::Agent);
        assert_eq!(assessment.artifact_inputs, ["produce"]);
        assert_eq!(assessment.artifact_access, ArtifactAccess::Immutable);
        assert!(assessment
            .output_schema
            .as_ref()
            .expect("assessment declares an output schema")
            .path
            .ends_with("schemas/assessment.schema.json"));
    }

    let synthesis = config
        .steps
        .iter()
        .find(|step| step.name == gate_config.adjudication_step)
        .expect("configured synthesis step");
    assert_eq!(synthesis.kind, StepKind::Synthesis);
    assert_eq!(
        synthesis.depends,
        Some(gate_config.assessment_steps.clone())
    );
    assert!(synthesis
        .output_schema
        .as_ref()
        .expect("synthesis declares an output schema")
        .path
        .ends_with("schemas/adjudication.schema.json"));

    let assessment_schema = examples.join("schemas/assessment.schema.json");
    let adjudication_schema = examples.join("schemas/adjudication.schema.json");
    let architecture_output = examples.join("outputs/architecture-assessment.json");
    let verification_output = examples.join("outputs/verification-assessment.json");
    let synthesis_output = examples.join("outputs/adjudication.json");
    schema_validates(&assessment_schema, &architecture_output);
    schema_validates(&assessment_schema, &verification_output);
    schema_validates(&adjudication_schema, &synthesis_output);

    let outputs = BTreeMap::from([
        (
            "architecture".to_string(),
            succeeded_output(&architecture_output),
        ),
        (
            "verification".to_string(),
            succeeded_output(&verification_output),
        ),
        ("synthesis".to_string(), succeeded_output(&synthesis_output)),
    ]);
    assert_eq!(
        evaluate_gate(
            &gate_config.assessment_steps,
            &gate_config.adjudication_step,
            &outputs,
        )
        .expect("example evidence is gate-valid")
        .outcome,
        GateOutcome::Passed
    );

    let guide = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/adversarial-reviews.md"),
    )
    .expect("canonical guide exists");
    for fixture in [
        "examples/adversarial-reviews/config.yaml",
        "examples/adversarial-reviews/schemas/assessment.schema.json",
        "examples/adversarial-reviews/schemas/adjudication.schema.json",
    ] {
        assert!(guide.contains(fixture), "guide links {fixture}");
    }

    for reference in ["configuration.md", "pipelines.md"] {
        let contents = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../docs")
                .join(reference),
        )
        .unwrap_or_else(|error| panic!("failed to read {reference}: {error}"));
        assert!(
            contents.contains("adversarial-reviews.md"),
            "{reference} links the canonical guide"
        );
    }

    let adr = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/adr/0017-evaluate-immutable-artifact-snapshots-with-generic-pipeline-primitives.md"),
    )
    .expect("ADR-0017 exists");
    assert!(adr.starts_with("---\nstatus: accepted\n---"));
    assert!(adr.contains("../adversarial-reviews.md"));
}
