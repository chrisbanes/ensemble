use crate::commands::init::agents::AgentEntry;
use ensemble_core::config::ensemble::{
    ArtifactAccess, ArtifactSnapshotConfig, EnsembleConfig, GateConfig, StepConfig, StepKind,
};

#[derive(Debug)]
pub struct PipelineStep {
    pub name: String,
    pub agent_role: String,
    pub kind: Option<String>,
    pub depends: Option<Vec<String>>,
    pub tracker_state: Option<String>,
    pub artifact_snapshot: Option<ArtifactSnapshotConfig>,
    pub artifact_inputs: Vec<String>,
    pub artifact_access: ArtifactAccess,
    pub gate: Option<GateConfig>,
}

fn pipeline_step_from_config(step: &StepConfig) -> PipelineStep {
    PipelineStep {
        name: step.name.clone(),
        agent_role: step.agent.clone(),
        kind: match step.kind {
            StepKind::Agent => None,
            StepKind::Synthesis => Some("synthesis".to_string()),
            StepKind::Gate => Some("gate".to_string()),
        },
        depends: step.depends.clone(),
        tracker_state: step.tracker_state.clone(),
        artifact_snapshot: step.artifact_snapshot.clone(),
        artifact_inputs: step.artifact_inputs.clone(),
        artifact_access: step.artifact_access,
        gate: step.gate.clone(),
    }
}

fn existing_pipeline_matches_roles(config: &EnsembleConfig, role_names: &[&str]) -> bool {
    config
        .steps
        .iter()
        .all(|step| step.kind == StepKind::Gate || role_names.contains(&step.agent.as_str()))
}

pub fn ask_pipeline(
    agents: &[AgentEntry],
    existing: Option<&EnsembleConfig>,
) -> Result<Vec<PipelineStep>, inquire::InquireError> {
    let role_names: Vec<&str> = agents.iter().map(|a| a.role.as_str()).collect();

    if agents.len() == 1 {
        if let Some(existing) = existing
            .filter(|config| existing_pipeline_matches_roles(config, &role_names))
            .filter(|config| !config.steps.is_empty())
        {
            let step_summary = existing
                .steps
                .iter()
                .map(|step| step.name.as_str())
                .collect::<Vec<_>>()
                .join(" → ");
            println!("\nPipeline: preserving existing ({step_summary})");
            return Ok(existing
                .steps
                .iter()
                .map(pipeline_step_from_config)
                .collect());
        }
        // Use existing config's first step only if its agent matches the current role
        let matching_step =
            existing.and_then(|c| c.steps.first().filter(|s| s.agent == role_names[0]));

        let step_name = matching_step
            .map(|s| s.name.as_str())
            .unwrap_or("implement");

        let tracker_state = matching_step
            .and_then(|s| s.tracker_state.as_deref())
            .unwrap_or("In Progress");

        println!(
            "\nPipeline: single step ({}) using {}",
            step_name, role_names[0]
        );
        let mut step = matching_step
            .map(pipeline_step_from_config)
            .unwrap_or(PipelineStep {
                name: step_name.to_string(),
                agent_role: role_names[0].to_string(),
                kind: None,
                depends: None,
                tracker_state: None,
                artifact_snapshot: None,
                artifact_inputs: Vec::new(),
                artifact_access: Default::default(),
                gate: None,
            });
        step.tracker_state = Some(tracker_state.to_string());
        return Ok(vec![step]);
    }

    // Check if existing pipeline matches current agent roles
    let existing_matches =
        existing.is_some_and(|config| existing_pipeline_matches_roles(config, &role_names));

    if existing_matches {
        let existing_steps = &existing.unwrap().steps;
        let step_summary: Vec<String> = existing_steps.iter().map(|s| s.name.clone()).collect();
        let summary = step_summary.join(" → ");

        let options = vec![
            format!("Yes, use existing ({summary})"),
            "Yes, use defaults (implement → review)".to_string(),
            "No, let me customize".to_string(),
        ];
        let choice = inquire::Select::new("Use existing pipeline?", options).prompt()?;

        if choice.starts_with("Yes, use existing") {
            return Ok(existing_steps
                .iter()
                .map(pipeline_step_from_config)
                .collect());
        } else if choice.starts_with("Yes, use defaults") {
            return Ok(default_pipeline(&role_names));
        }
        // else: fall through to custom
        return custom_pipeline(&role_names);
    }

    let options = vec![
        "Yes, use defaults (implement → review)",
        "No, let me customize",
    ];
    let choice = inquire::Select::new("Use default pipeline?", options).prompt()?;

    if choice.starts_with("Yes") {
        Ok(default_pipeline(&role_names))
    } else {
        custom_pipeline(&role_names)
    }
}

fn default_pipeline(role_names: &[&str]) -> Vec<PipelineStep> {
    let mut steps = vec![PipelineStep {
        name: "implement".to_string(),
        agent_role: role_names[0].to_string(),
        kind: None,
        depends: None,
        tracker_state: Some("In Progress".to_string()),
        artifact_snapshot: None,
        artifact_inputs: Vec::new(),
        artifact_access: Default::default(),
        gate: None,
    }];

    if role_names.len() >= 2 {
        steps.push(PipelineStep {
            name: "review".to_string(),
            agent_role: role_names[1].to_string(),
            kind: None,
            depends: Some(vec!["implement".to_string()]),
            tracker_state: Some("Review".to_string()),
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
            gate: None,
        });
    }

    steps
}

fn custom_pipeline(role_names: &[&str]) -> Result<Vec<PipelineStep>, inquire::InquireError> {
    let mut steps = Vec::new();
    let mut step_num = 1;

    loop {
        println!("\nStep {step_num}:");

        let name = inquire::Text::new("  Name:")
            .with_default(if step_num == 1 { "implement" } else { "" })
            .prompt()?;

        let agent_role = inquire::Select::new("  Agent:", role_names.to_vec())
            .prompt()?
            .to_string();

        let depends = if steps.is_empty() {
            None
        } else {
            let step_names: Vec<String> = steps
                .iter()
                .map(|s: &PipelineStep| s.name.clone())
                .collect();
            Some(inquire::MultiSelect::new("  Depends on:", step_names).prompt()?)
        };

        steps.push(PipelineStep {
            name,
            agent_role,
            kind: None,
            depends,
            tracker_state: None,
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
            gate: None,
        });

        let more = inquire::Confirm::new("Add another step?")
            .with_default(false)
            .prompt()?;

        if !more {
            break;
        }

        step_num += 1;
    }

    Ok(steps)
}

#[cfg(test)]
mod tests {
    use super::{default_pipeline, existing_pipeline_matches_roles, pipeline_step_from_config};
    use crate::commands::init::agents::AgentEntry;
    use ensemble_core::config::ensemble::{parse_config, ArtifactAccess};

    #[test]
    fn default_pipeline_keeps_implicit_sequencing() {
        let steps = default_pipeline(&["builder", "reviewer"]);

        assert_eq!(steps[0].depends, None);
        assert_eq!(steps[1].depends, Some(vec!["implement".to_string()]));
    }

    #[test]
    fn existing_pipeline_steps_preserve_gate_and_artifact_contracts() {
        let config = parse_config(
            r#"
tracker:
  kind: todo_file
repos:
  - path: /tmp/repo
    branch: main
agents:
  builder:
    acpx_agent: claude
    prompt: Work.
steps:
  - name: build
    agent: builder
    artifact_snapshot:
      repositories: [repo]
  - name: review
    agent: builder
    depends: [build]
    artifact_inputs: [build]
    artifact_access: immutable
  - name: adjudicate
    kind: synthesis
    agent: builder
    depends: [review]
  - name: assess
    kind: gate
    depends: [review, adjudicate]
    gate:
      assessment_steps: [review]
      adjudication_step: adjudicate
on_success: Done
on_failure: Failed
"#,
        )
        .unwrap();

        let steps = config
            .steps
            .iter()
            .map(pipeline_step_from_config)
            .collect::<Vec<_>>();

        assert!(existing_pipeline_matches_roles(&config, &["builder"]));
        let selected = super::ask_pipeline(
            &[AgentEntry {
                role: "builder".to_string(),
                acpx_agent: "claude".to_string(),
                model: None,
            }],
            Some(&config),
        )
        .unwrap();
        assert_eq!(selected.len(), 4);
        assert_eq!(selected[1].artifact_access, ArtifactAccess::Immutable);
        assert_eq!(selected[3].kind.as_deref(), Some("gate"));

        assert_eq!(
            steps[0].artifact_snapshot.as_ref().unwrap().repositories,
            ["repo".to_string()]
        );
        assert_eq!(steps[1].artifact_inputs, ["build".to_string()]);
        assert_eq!(steps[1].artifact_access, ArtifactAccess::Immutable);
        assert_eq!(steps[3].kind.as_deref(), Some("gate"));
        assert_eq!(
            steps[3].gate.as_ref().unwrap().adjudication_step,
            "adjudicate"
        );
    }
}
