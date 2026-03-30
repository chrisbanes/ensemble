use crate::init::agents::AgentEntry;

#[derive(Debug)]
pub struct PipelineStep {
    pub name: String,
    pub agent_role: String,
    pub depends: Vec<String>,
    pub tracker_state: Option<String>,
}

pub fn ask_pipeline(agents: &[AgentEntry]) -> Result<Vec<PipelineStep>, inquire::InquireError> {
    let role_names: Vec<&str> = agents.iter().map(|a| a.role.as_str()).collect();

    if agents.len() == 1 {
        println!(
            "\nPipeline: single step (implement) using {}",
            role_names[0]
        );
        return Ok(vec![PipelineStep {
            name: "implement".to_string(),
            agent_role: role_names[0].to_string(),
            depends: vec![],
            tracker_state: Some("In Progress".to_string()),
        }]);
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
        depends: vec![],
        tracker_state: Some("In Progress".to_string()),
    }];

    if role_names.len() >= 2 {
        steps.push(PipelineStep {
            name: "review".to_string(),
            agent_role: role_names[1].to_string(),
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
