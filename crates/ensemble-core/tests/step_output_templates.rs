use ensemble_core::config::ensemble::{OnFailure, StepConfig, StepKind};
use ensemble_core::config::template::render_prompt_with_context;
use ensemble_core::pipeline::dag::build_dag;
use ensemble_core::pipeline::engine::PipelineRun;
use ensemble_core::pipeline::verdict::{StepOutput, StepResult};
use ensemble_core::tracker::model::Issue;
use serde_json::json;

fn sample_issue() -> Issue {
    Issue {
        id: "NODE_1".to_string(),
        identifier: "proj#10".to_string(),
        title: "Add feature X".to_string(),
        description: Some("Implement feature X".to_string()),
        priority: Some(1),
        tracker_position: None,
        state: "Todo".to_string(),
        branch_name: None,
        url: None,
        labels: vec![],
        blocked_by: vec![],
        created_at: None,
        updated_at: None,
    }
}

fn make_step(name: &str, agent: &str, depends: &[&str]) -> StepConfig {
    StepConfig {
        name: name.to_string(),
        kind: StepKind::Agent,
        agent: agent.to_string(),
        depends: if depends.is_empty() {
            None
        } else {
            Some(depends.iter().map(|s| s.to_string()).collect())
        },
        tracker_state: None,
        timeout_ms: None,
        approval: None,
        on_failure: OnFailure::RetryIssue,
        fixup_agent: None,
        resource_requests: Default::default(),
        affected_paths: None,
        output_schema: None,
        artifact_snapshot: None,
        artifact_inputs: Vec::new(),
        artifact_access: Default::default(),
        gate: None,
        authorization: None,
    }
}

#[test]
fn render_prompt_with_dependency_outputs() {
    // DAG: build → review-a + review-b → synth
    let steps = vec![
        make_step("build", "builder", &[]),
        make_step("review-a", "reviewer", &["build"]),
        make_step("review-b", "reviewer", &["build"]),
        make_step("synth", "synthesizer", &["review-a", "review-b"]),
    ];
    let dag = build_dag(&steps).unwrap();
    let mut run = PipelineRun::new("issue-10".to_string(), 1, dag);

    // Complete build
    run.step_completed(
        "build",
        StepOutput {
            result: StepResult::Succeeded,
            summary: Some("built ok".to_string()),
            output: Some(json!({"artifact": "branch"})),
        },
        false,
    );

    // Complete review-a
    run.step_completed(
        "review-a",
        StepOutput {
            result: StepResult::Succeeded,
            summary: Some("review a passed".to_string()),
            output: Some(json!({"risk": "low", "findings": ["minor nit"]})),
        },
        false,
    );

    // Complete review-b
    run.step_completed(
        "review-b",
        StepOutput {
            result: StepResult::Succeeded,
            summary: Some("review b passed".to_string()),
            output: Some(json!({"risk": "medium", "findings": ["missing tests"]})),
        },
        false,
    );

    // Get template context for synth step
    let context = run
        .output_context_for("synth")
        .expect("synth step should exist");

    // Verify context structure
    assert_eq!(
        context.dependency_outputs.len(),
        2,
        "synth has 2 direct dependencies"
    );
    assert_eq!(context.dependency_outputs[0].step, "review-a");
    assert_eq!(context.dependency_outputs[1].step, "review-b");
    assert!(context.steps.contains_key("build"));
    assert!(context.steps.contains_key("review-a"));
    assert!(context.steps.contains_key("review-b"));

    // Render a template that iterates dependency_outputs
    let template = r#"{% for review in dependency_outputs %}
## {{ review.step }}
{{ review.summary }}
Risk: {{ review.output.risk }}
{% endfor %}"#;

    let rendered =
        render_prompt_with_context(template, &sample_issue(), None, None, Some(&context)).unwrap();

    assert!(
        rendered.contains("## review-a"),
        "should contain review-a heading"
    );
    assert!(
        rendered.contains("review a passed"),
        "should contain review-a summary"
    );
    assert!(
        rendered.contains("Risk: low"),
        "should contain review-a risk"
    );
    assert!(
        rendered.contains("## review-b"),
        "should contain review-b heading"
    );
    assert!(
        rendered.contains("review b passed"),
        "should contain review-b summary"
    );
    assert!(
        rendered.contains("Risk: medium"),
        "should contain review-b risk"
    );

    // Render a template that accesses specific steps by name
    let named_template = r#"Risk A: {{ steps["review-a"].output.risk }}, Risk B: {{ steps["review-b"].output.risk }}"#;
    let rendered =
        render_prompt_with_context(named_template, &sample_issue(), None, None, Some(&context))
            .unwrap();

    assert_eq!(rendered, "Risk A: low, Risk B: medium");
}

#[test]
fn output_context_for_returns_none_for_unknown_step() {
    let steps = vec![make_step("build", "builder", &[])];
    let dag = build_dag(&steps).unwrap();
    let run = PipelineRun::new("issue-1".to_string(), 1, dag);

    assert!(run.output_context_for("nonexistent").is_none());
}

#[test]
fn dependency_outputs_only_include_direct_deps() {
    // DAG: a → b → c
    let steps = vec![
        make_step("a", "agent", &[]),
        make_step("b", "agent", &["a"]),
        make_step("c", "agent", &["b"]),
    ];
    let dag = build_dag(&steps).unwrap();
    let mut run = PipelineRun::new("issue-1".to_string(), 1, dag);

    run.step_completed(
        "a",
        StepOutput {
            result: StepResult::Succeeded,
            summary: Some("a done".to_string()),
            output: Some(json!({"step": "a"})),
        },
        false,
    );
    run.step_completed(
        "b",
        StepOutput {
            result: StepResult::Succeeded,
            summary: Some("b done".to_string()),
            output: Some(json!({"step": "b"})),
        },
        false,
    );

    let context = run.output_context_for("c").unwrap();
    // c depends only on b, not on a
    assert_eq!(context.dependency_outputs.len(), 1);
    assert_eq!(context.dependency_outputs[0].step, "b");
    // But steps map contains all completed steps
    assert_eq!(context.steps.len(), 2);
}
