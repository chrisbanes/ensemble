use crate::commands::init::agents::AgentEntry;
use ensemble_core::config::ensemble::EnsembleConfig;

#[derive(Debug)]
pub struct PipelineStep {
    pub name: String,
    pub agent_role: String,
    pub kind: Option<String>,
    pub depends: Vec<String>,
    pub tracker_state: Option<String>,
}

pub fn ask_pipeline(
    agents: &[AgentEntry],
    existing: Option<&EnsembleConfig>,
) -> Result<Vec<PipelineStep>, inquire::InquireError> {
    let role_names: Vec<&str> = agents.iter().map(|a| a.role.as_str()).collect();

    if agents.len() == 1 {
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
        return Ok(vec![PipelineStep {
            name: step_name.to_string(),
            agent_role: role_names[0].to_string(),
            kind: None,
            depends: vec![],
            tracker_state: Some(tracker_state.to_string()),
        }]);
    }

    // Check if existing pipeline matches current agent roles
    let existing_matches = existing.is_some_and(|config| {
        config
            .steps
            .iter()
            .all(|step| role_names.contains(&step.agent.as_str()))
    });

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
                .map(|s| PipelineStep {
                    name: s.name.clone(),
                    agent_role: s.agent.clone(),
                    kind: None,
                    depends: s.depends.clone().unwrap_or_default(),
                    tracker_state: s.tracker_state.clone(),
                })
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
        depends: vec![],
        tracker_state: Some("In Progress".to_string()),
    }];

    if role_names.len() >= 2 {
        steps.push(PipelineStep {
            name: "review".to_string(),
            agent_role: role_names[1].to_string(),
            kind: None,
            depends: vec!["implement".to_string()],
            tracker_state: Some("Review".to_string()),
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
            vec![]
        } else {
            let step_names: Vec<String> = steps
                .iter()
                .map(|s: &PipelineStep| s.name.clone())
                .collect();
            inquire::MultiSelect::new("  Depends on:", step_names).prompt()?
        };

        steps.push(PipelineStep {
            name,
            agent_role,
            kind: None,
            depends,
            tracker_state: None,
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
