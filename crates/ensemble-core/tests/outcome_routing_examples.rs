use std::path::{Path, PathBuf};

use ensemble_core::config::ensemble::{
    load_config, validate_config, ArtifactAccess, StepActionConfig, StepKind,
};
use ensemble_core::pipeline::dag::build_dag;
use ensemble_core::pipeline::engine::{PipelineAction, PipelineRun, ResolvedStepAction, StepState};
use ensemble_core::pipeline::verdict::{StepOutput, StepResult};
use ensemble_core::tracker::create_tracker;

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
    assert!(producer.actions.is_empty());
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
    assert_eq!(protected.actions.len(), 1);
    assert!(matches!(
        protected.actions[0],
        StepActionConfig::TrackerComment { .. }
    ));

    let operator = config
        .steps
        .iter()
        .find(|step| step.name == "notify_operator")
        .unwrap();
    assert_eq!(operator.actions.len(), 2);

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

    // This is an activation-level capability check, not merely schema loading:
    // the public reference must be runnable with its declared comment action.
    let tracker = create_tracker(&config.tracker).unwrap();
    assert!(tracker.supports_idempotent_comment_publication());
}

#[test]
fn outcome_routing_example_executes_actions_only_on_the_selected_branch() {
    let root = example_root();
    let config = load_config(&root.join("config.yaml")).unwrap();
    let run_for = |outcome: &str| {
        let mut run = PipelineRun::new(
            "example-1".to_string(),
            1,
            build_dag(&config.steps).unwrap(),
        );
        assert!(matches!(run.start(), PipelineAction::Dispatch(_)));
        let action = run.step_completed(
            "produce",
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: Some(read_json(
                    &root.join("outputs").join(format!("{outcome}.json")),
                )),
            },
            false,
        );
        (run, action)
    };

    let (mut revised, action) = run_for("revised-artifact");
    assert!(
        matches!(action, PipelineAction::Dispatch(ref requests) if requests[0].step_name == "publish_revision")
    );
    assert!(matches!(
        revised.step_states["notify_operator"],
        StepState::Skipped { .. }
    ));
    revised.step_completed(
        "publish_revision",
        StepOutput {
            result: StepResult::Succeeded,
            summary: None,
            output: Some(read_json(&root.join("outputs/publication.json"))),
        },
        false,
    );
    assert!(matches!(
        revised.pending_action("publish_revision").unwrap().action,
        ResolvedStepAction::TrackerComment { .. }
    ));
    assert!(revised.pending_action("notify_operator").is_none());

    let (mut operator, action) = run_for("operator-required");
    assert!(
        matches!(action, PipelineAction::Dispatch(ref requests) if requests[0].step_name == "notify_operator")
    );
    assert!(matches!(
        operator.step_states["publish_revision"],
        StepState::Skipped { .. }
    ));
    operator.step_completed(
        "notify_operator",
        StepOutput {
            result: StepResult::Succeeded,
            summary: None,
            output: Some(read_json(&root.join("outputs/operator-attention.json"))),
        },
        false,
    );
    assert!(matches!(
        operator.pending_action("notify_operator").unwrap().action,
        ResolvedStepAction::TrackerComment { .. }
    ));
    assert!(operator.pending_action("publish_revision").is_none());
}
