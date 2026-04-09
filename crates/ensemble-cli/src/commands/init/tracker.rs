use ensemble_core::config::ensemble::EnsembleConfig;
use ensemble_core::config::location::default_todo_state_path;
use ensemble_core::tracker::resolve_github_token_for_endpoint;
use std::path::PathBuf;

use inquire::{MultiSelect, Password, Select, Text};

/// The tracker choice collected from the user during the init wizard.
#[derive(Debug)]
pub enum TrackerChoice {
    TodoFile {
        path: PathBuf,
    },
    GitHub {
        repository: String,
        project_number: Option<i64>,
        api_key_env: String,
        api_token: Option<String>,
        active_states: Vec<String>,
        terminal_states: Vec<String>,
        on_success: String,
        on_failure: String,
    },
}

/// Ask the user where their issues live, then collect the relevant credentials.
pub async fn ask_tracker(
    existing: Option<&EnsembleConfig>,
) -> Result<TrackerChoice, inquire::InquireError> {
    let options = vec!["GitHub Projects", "TODO.md (great for trying things out)"];

    // Default to the existing tracker kind
    let default_index = existing
        .map(|c| if c.tracker.kind == "github" { 0 } else { 1 })
        .unwrap_or(1);

    let choice = Select::new("Where do your issues live?", options)
        .with_starting_cursor(default_index)
        .prompt()?;

    match choice {
        "GitHub Projects" => ask_github_tracker(existing).await,
        _ => {
            let default_path = existing
                .and_then(|c| c.tracker.path.as_ref())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| {
                    default_todo_state_path()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|_| "~/ensemble/TODO.md".to_string())
                });

            let path_str = Text::new("TODO file path:")
                .with_default(&default_path)
                .prompt()?;

            println!("Creating {} with a sample issue...", path_str);
            Ok(TrackerChoice::TodoFile {
                path: PathBuf::from(path_str),
            })
        }
    }
}

/// Collect GitHub-specific tracker config interactively.
async fn ask_github_tracker(
    existing: Option<&EnsembleConfig>,
) -> Result<TrackerChoice, inquire::InquireError> {
    let default_repo = existing
        .and_then(|c| c.tracker.repository.as_deref())
        .unwrap_or("");

    let repository = Text::new("GitHub repository (owner/repo):")
        .with_help_message("e.g. acme/frontend")
        .with_default(default_repo)
        .prompt()?;

    let default_proj = existing
        .and_then(|c| c.tracker.project_number)
        .map(|n| n.to_string())
        .unwrap_or_default();

    let project_number_str =
        Text::new("GitHub Project board number (optional, press enter to skip):")
            .with_default(&default_proj)
            .prompt()?;

    let project_number: Option<i64> = if project_number_str.trim().is_empty() {
        None
    } else {
        match project_number_str.trim().parse::<i64>() {
            Ok(n) => Some(n),
            Err(_) => {
                eprintln!(
                    "Warning: could not parse project number '{}', skipping.",
                    project_number_str.trim()
                );
                None
            }
        }
    };

    // Check for $GITHUB_TOKEN in env.
    // `api_token` is only Some when the user enters the token interactively.
    // When loaded from env, api_token is None and the token is not written to .env.
    let endpoint = existing.and_then(|c| c.tracker.endpoint.as_deref());
    let gh_hostname = existing.and_then(|c| c.tracker.gh_hostname.as_deref());
    let (token, api_token) =
        if let Some((token, source)) = resolve_env_or_gh_token(endpoint, gh_hostname) {
            match source {
                GithubTokenSource::Env => println!("GitHub token ($GITHUB_TOKEN detected ✓)"),
                GithubTokenSource::Gh => println!("GitHub token (from gh auth token ✓)"),
            }
            (token, None)
        } else {
            let t = Password::new("GitHub token (not found in $GITHUB_TOKEN — enter now):")
                .with_help_message("The token will be stored in .env and exported as $GITHUB_TOKEN")
                .prompt()?;
            (t.clone(), Some(t))
        };

    // api_key_env is used in the generated config to reference the env var
    let api_key_env = "GITHUB_TOKEN".to_string();

    // Fetch real board statuses if project_number is provided
    let available_statuses: Vec<String> = if let Some(proj_num) = project_number {
        let owner = repository.split('/').next().unwrap_or("").to_string();
        println!("Fetching board statuses...");
        match fetch_board_statuses(&owner, proj_num, &token).await {
            Ok(statuses) if !statuses.is_empty() => {
                println!("  Found: {}", statuses.join(", "));
                statuses
            }
            Ok(_) => {
                eprintln!("  No statuses found on board, using defaults.");
                default_statuses()
            }
            Err(e) => {
                eprintln!("  Could not fetch board statuses: {}. Using defaults.", e);
                default_statuses()
            }
        }
    } else {
        default_statuses()
    };

    let (active_states, on_success, on_failure) =
        ask_status_mapping(&available_statuses, existing)?;

    // terminal_states = the success state (and failure if present on the board)
    let mut terminal_states = vec![on_success.clone()];
    if available_statuses.contains(&on_failure) && !terminal_states.contains(&on_failure) {
        terminal_states.push(on_failure.clone());
    }

    Ok(TrackerChoice::GitHub {
        repository,
        project_number,
        api_key_env,
        api_token,
        active_states,
        terminal_states,
        on_success,
        on_failure,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GithubTokenSource {
    Env,
    Gh,
}

fn resolve_env_or_gh_token(
    endpoint: Option<&str>,
    gh_hostname: Option<&str>,
) -> Option<(String, GithubTokenSource)> {
    if let Ok(t) = std::env::var("GITHUB_TOKEN") {
        if !t.trim().is_empty() {
            return Some((t, GithubTokenSource::Env));
        }
    }

    resolve_github_token_for_endpoint(None, endpoint, gh_hostname)
        .map(|t| (t, GithubTokenSource::Gh))
}

/// Default status names used when GitHub API is unavailable or no board is specified.
fn default_statuses() -> Vec<String> {
    vec![
        "Todo".to_string(),
        "In Progress".to_string(),
        "Done".to_string(),
    ]
}

/// Prompt the user to select active states and map success/failure statuses.
///
/// When `existing` config is provided, defaults are seeded from the existing
/// tracker's `active_states`, `on_success`, and `on_failure` values.
///
/// Returns `(active_states, on_success, on_failure)`.
pub fn ask_status_mapping(
    available_statuses: &[String],
    existing: Option<&EnsembleConfig>,
) -> Result<(Vec<String>, String, String), inquire::InquireError> {
    // Compute default indices for active states from existing config
    let default_active_indices: Vec<usize> = existing
        .map(|c| {
            c.tracker
                .active_states
                .iter()
                .filter_map(|s| available_statuses.iter().position(|a| a == s))
                .collect()
        })
        .unwrap_or_default();
    let default_active_indices = if default_active_indices.is_empty() {
        vec![0]
    } else {
        default_active_indices
    };

    // Multi-select active states
    let active_states: Vec<String> = MultiSelect::new(
        "Which statuses should Ensemble pick up work from? (space to toggle)",
        available_statuses.to_vec(),
    )
    .with_default(&default_active_indices)
    .prompt()?;

    // Compute default cursor for success state from existing config
    let success_default_idx = existing
        .and_then(|c| available_statuses.iter().position(|s| s == &c.on_success))
        .unwrap_or(0);

    // Select success state
    let on_success = Select::new(
        "Which status means work is complete?",
        available_statuses.to_vec(),
    )
    .with_starting_cursor(success_default_idx)
    .prompt()?
    .to_string();

    // Default failure state from existing config
    let default_failure = existing.map(|c| c.on_failure.as_str()).unwrap_or("Failed");

    // Free-text failure state
    let on_failure = Text::new("Which status means work failed? (press enter to use \"Failed\")")
        .with_default(default_failure)
        .prompt()?;

    Ok((active_states, on_success, on_failure))
}

/// Fetch status option names from GitHub Projects v2 API for a given project.
///
/// Tries `user(login: $owner)` first, then falls back to `organization(login: $owner)`.
/// Returns the list of status option names, or an error string on failure.
pub async fn fetch_board_statuses(
    owner: &str,
    project_number: i64,
    token: &str,
) -> Result<Vec<String>, String> {
    // Try user first, then organization
    match fetch_board_statuses_as_user(owner, project_number, token).await {
        Ok(statuses) => Ok(statuses),
        Err(e) => {
            eprintln!("  User query failed (trying organization): {}", e);
            fetch_board_statuses_as_org(owner, project_number, token).await
        }
    }
}

/// GraphQL query targeting `user(login: $owner)`.
async fn fetch_board_statuses_as_user(
    owner: &str,
    project_number: i64,
    token: &str,
) -> Result<Vec<String>, String> {
    let query = r#"
query($owner: String!, $projectNumber: Int!) {
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      field(name: "Status") {
        ... on ProjectV2SingleSelectField {
          options {
            name
          }
        }
      }
    }
  }
}
"#;
    let variables = serde_json::json!({
        "owner": owner,
        "projectNumber": project_number,
    });

    let response = execute_graphql(query, variables, token).await?;
    extract_status_options_from_path(
        &response,
        &["data", "user", "projectV2", "field", "options"],
    )
}

/// GraphQL query targeting `organization(login: $owner)`.
async fn fetch_board_statuses_as_org(
    owner: &str,
    project_number: i64,
    token: &str,
) -> Result<Vec<String>, String> {
    let query = r#"
query($owner: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      field(name: "Status") {
        ... on ProjectV2SingleSelectField {
          options {
            name
          }
        }
      }
    }
  }
}
"#;
    let variables = serde_json::json!({
        "owner": owner,
        "projectNumber": project_number,
    });

    let response = execute_graphql(query, variables, token).await?;
    extract_status_options_from_path(
        &response,
        &["data", "organization", "projectV2", "field", "options"],
    )
}

/// Send a GraphQL request to the GitHub API and return the parsed JSON response.
async fn execute_graphql(
    query: &str,
    variables: serde_json::Value,
    token: &str,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "query": query,
        "variables": variables,
    });

    let response = client
        .post("https://api.github.com/graphql")
        .header("Authorization", format!("Bearer {}", token))
        .header(
            "User-Agent",
            concat!("ensemble-cli/", env!("CARGO_PKG_VERSION")),
        )
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API HTTP error: {}", response.status()));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("failed to parse GitHub API response: {}", e))?;

    if let Some(errors) = body.get("errors").and_then(|e| e.as_array()) {
        let messages: Vec<String> = errors
            .iter()
            .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
            .map(String::from)
            .collect();
        if !messages.is_empty() {
            return Err(format!("GitHub GraphQL error: {}", messages.join("; ")));
        }
    }

    Ok(body)
}

/// Walk a JSON path and extract the `name` fields from an array of option objects.
fn extract_status_options_from_path(
    value: &serde_json::Value,
    path: &[&str],
) -> Result<Vec<String>, String> {
    let mut current = value;
    for &key in path {
        current = current
            .get(key)
            .ok_or_else(|| format!("missing key '{}' in response", key))?;
    }

    let options = current
        .as_array()
        .ok_or_else(|| "expected array of options".to_string())?;

    let names: Vec<String> = options
        .iter()
        .filter_map(|opt| opt.get("name").and_then(|n| n.as_str()).map(str::to_owned))
        .collect();

    if names.is_empty() {
        return Err("no status options found".to_string());
    }

    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn test_default_statuses() {
        let defaults = default_statuses();
        assert_eq!(defaults, vec!["Todo", "In Progress", "Done"]);
    }

    #[test]
    fn test_extract_status_options_from_path_happy_path() {
        let value = serde_json::json!({
            "data": {
                "user": {
                    "projectV2": {
                        "field": {
                            "options": [
                                {"name": "Todo"},
                                {"name": "In Progress"},
                                {"name": "Done"},
                            ]
                        }
                    }
                }
            }
        });
        let result = extract_status_options_from_path(
            &value,
            &["data", "user", "projectV2", "field", "options"],
        );
        assert_eq!(result.unwrap(), vec!["Todo", "In Progress", "Done"]);
    }

    #[test]
    fn test_extract_status_options_from_path_missing_key() {
        let value = serde_json::json!({"data": {}});
        let result = extract_status_options_from_path(
            &value,
            &["data", "user", "projectV2", "field", "options"],
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("missing key 'user'"));
    }

    #[test]
    fn test_extract_status_options_empty_array() {
        let value = serde_json::json!({"options": []});
        let result = extract_status_options_from_path(&value, &["options"]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no status options found"));
    }

    #[test]
    fn test_tracker_choice_github_fields() {
        let choice = TrackerChoice::GitHub {
            repository: "acme/frontend".to_string(),
            project_number: Some(42),
            api_key_env: "GITHUB_TOKEN".to_string(),
            api_token: None,
            active_states: vec!["Todo".to_string()],
            terminal_states: vec!["Done".to_string(), "Failed".to_string()],
            on_success: "Done".to_string(),
            on_failure: "Failed".to_string(),
        };
        match choice {
            TrackerChoice::GitHub {
                repository,
                project_number,
                ..
            } => {
                assert_eq!(repository, "acme/frontend");
                assert_eq!(project_number, Some(42));
            }
            _ => panic!("expected GitHub variant"),
        }
    }

    #[test]
    fn test_tracker_choice_todo_file() {
        let choice = TrackerChoice::TodoFile {
            path: PathBuf::from("TODO.md"),
        };
        match choice {
            TrackerChoice::TodoFile { path } => {
                assert_eq!(path, PathBuf::from("TODO.md"));
            }
            _ => panic!("expected TodoFile variant"),
        }
    }

    #[test]
    fn resolve_env_or_gh_token_ignores_blank_env_values() {
        let _lock = ENV_LOCK.lock().unwrap();
        let original_token = std::env::var("GITHUB_TOKEN").ok();
        let original_gh_bin = std::env::var("ENSEMBLE_GH_BIN").ok();
        std::env::set_var("GITHUB_TOKEN", "   ");
        std::env::set_var("ENSEMBLE_GH_BIN", "__missing_gh_binary__");

        let resolved = resolve_env_or_gh_token(None, None);
        assert!(resolved.is_none());

        match original_token {
            Some(value) => std::env::set_var("GITHUB_TOKEN", value),
            None => std::env::remove_var("GITHUB_TOKEN"),
        }
        match original_gh_bin {
            Some(value) => std::env::set_var("ENSEMBLE_GH_BIN", value),
            None => std::env::remove_var("ENSEMBLE_GH_BIN"),
        }
    }
}
