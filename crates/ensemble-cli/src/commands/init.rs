use ensemble_core::config::ensemble::{load_config, EnsembleConfig};
use ensemble_core::config::location::resolve_config_dir_for_cli;
use std::path::PathBuf;
use std::process::ExitCode;

pub mod agents;
pub mod generate;
pub mod pipeline;
pub mod repos;
pub mod tracker;
pub mod validate;

#[derive(Debug, Clone)]
pub struct InitArgs {
    pub config_dir: Option<PathBuf>,
}

/// Run the interactive initialization wizard
pub async fn execute(args: InitArgs) -> ExitCode {
    println!();

    // Resolve config directory
    let cwd = match std::env::current_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("error: failed to get current directory: {}", e);
            return ExitCode::FAILURE;
        }
    };

    let resolved = match resolve_config_dir_for_cli(
        args.config_dir.as_deref(),
        std::env::var_os("ENSEMBLE_CONFIG_DIR"),
        &cwd,
    ) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: failed to resolve config directory: {}", e);
            return ExitCode::FAILURE;
        }
    };

    // Check for legacy ensemble.yaml and warn
    let legacy_path = resolved.config_dir.join("ensemble.yaml");
    if legacy_path.exists() && !resolved.config_path.exists() {
        eprintln!(
            "found legacy ensemble.yaml at {} - rename it to config.yaml",
            legacy_path.display()
        );
    }

    // Try to load existing config for defaults
    let existing: Option<EnsembleConfig> = if resolved.config_path.exists() {
        let overwrite = match inquire::Confirm::new(&format!(
            "{} already exists. Overwrite?",
            resolved.config_path.display()
        ))
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
        match load_config(&resolved.config_path) {
            Ok(config) => {
                println!("  (using existing values as defaults)\n");
                Some(config)
            }
            Err(e) => {
                eprintln!("  Warning: could not parse existing config: {e}");
                eprintln!("  Proceeding without defaults.\n");
                None
            }
        }
    } else {
        None
    };

    let existing_ref = existing.as_ref();

    let tracker_result = match tracker::ask_tracker(existing_ref).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let repos = match repos::ask_repos(existing_ref) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };

    let discovered_agents = match agents::discover_agents(existing_ref) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };

    let steps = match pipeline::ask_pipeline(&discovered_agents, existing_ref) {
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
        &resolved.config_dir,
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

    println!(
        "\n✓ Configuration written to {}",
        resolved.config_dir.display()
    );
    println!("  - config.yaml: main configuration file");
    println!("  - .env: environment variables (auto-loaded)");
    println!("  - templates/: prompt templates");
    if let tracker::TrackerChoice::TodoFile { path } = &tracker_result {
        println!("  - TODO state: {}", path.display());
    }

    ExitCode::SUCCESS
}
