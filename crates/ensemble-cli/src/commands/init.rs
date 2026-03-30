use std::process::ExitCode;

pub mod agents;
pub mod generate;
pub mod pipeline;
pub mod repos;
pub mod tracker;
pub mod validate;

#[derive(Debug, Clone)]
pub struct InitArgs;

/// Run the interactive initialization wizard
pub async fn execute(_args: InitArgs) -> ExitCode {
    println!();

    if std::path::Path::new("ensemble.yaml").exists() {
        let overwrite = match inquire::Confirm::new("ensemble.yaml already exists. Overwrite?")
            .with_default(false)
            .prompt()
        {
            Ok(v) => v,
            Err(_) => return ExitCode::FAILURE,
        };
        if !overwrite {
            println!("Aborted.");
            return ExitCode::SUCCESS;
        }
    }

    let tracker_result = match tracker::ask_tracker().await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let repos = match repos::ask_repos() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let discovered_agents = match agents::discover_agents() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };

    let steps = match pipeline::ask_pipeline(&discovered_agents) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let proceed =
        validate::run_validation(&tracker_result, &repos, &discovered_agents, &steps).await;
    let proceed = match proceed {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error during validation: {e}");
            return ExitCode::FAILURE;
        }
    };
    if !proceed {
        println!("Aborted.");
        return ExitCode::SUCCESS;
    }

    let (on_success, on_failure) = match &tracker_result {
        tracker::TrackerChoice::GitHub {
            on_success,
            on_failure,
            ..
        } => (on_success.clone(), on_failure.clone()),
        tracker::TrackerChoice::TodoFile { .. } => ("Done".to_string(), "Failed".to_string()),
    };

    if let Err(e) = generate::write_files(
        &tracker_result,
        &repos,
        &discovered_agents,
        &steps,
        &on_success,
        &on_failure,
    ) {
        eprintln!("error writing files: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}
