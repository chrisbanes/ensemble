use std::path::PathBuf;
use std::process::Command;

#[derive(Debug)]
pub struct RepoEntry {
    pub path: PathBuf,
    pub branch: String,
}

/// Detect the default branch for a repository by querying origin/HEAD.
/// Returns the branch name with the "origin/" prefix stripped.
fn detect_default_branch(repo_path: &PathBuf) -> Option<String> {
    let output = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(repo_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim();

    // Strip the "origin/" prefix if present
    let branch = if let Some(stripped) = trimmed.strip_prefix("origin/") {
        stripped.to_string()
    } else {
        trimmed.to_string()
    };

    if branch.is_empty() {
        None
    } else {
        Some(branch)
    }
}

/// Check whether a branch exists in the given repository.
fn branch_exists(repo_path: &PathBuf, branch: &str) -> bool {
    let refspec = format!("refs/heads/{}", branch);
    Command::new("git")
        .args(["rev-parse", "--verify", &refspec])
        .current_dir(repo_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run the repos wizard step.
///
/// Prints a header, then loops asking for repo paths (numbered). A blank
/// entry ends the loop. At least one repo is required. Each repo is
/// validated as a git repo, a default branch is detected, and the user is
/// asked to confirm or override the target branch. If a branch does not
/// exist the user gets one retry before the repo is skipped.
pub fn ask_repos() -> Result<Vec<RepoEntry>, inquire::InquireError> {
    println!("Which repos should agents work in?");

    let mut repos: Vec<RepoEntry> = Vec::new();
    let mut index = 1usize;

    loop {
        let prompt = format!("Repo {} path (blank to finish)", index);
        let raw = inquire::Text::new(&prompt).prompt()?;
        let trimmed = raw.trim().to_string();

        if trimmed.is_empty() {
            if repos.is_empty() {
                println!("At least one repo is required. Please enter a path.");
                continue;
            }
            break;
        }

        let input_path = PathBuf::from(&trimmed);

        // Canonicalize the path so we store an absolute, normalized path.
        let canonical = match std::fs::canonicalize(&input_path) {
            Ok(p) => p,
            Err(e) => {
                println!(
                    "Cannot resolve path '{}': {}. Please try again.",
                    trimmed, e
                );
                continue;
            }
        };

        // Validate it is a git repository.
        if !canonical.join(".git").exists() {
            println!(
                "'{}' does not appear to be a git repository (no .git directory found). Please try again.",
                canonical.display()
            );
            continue;
        }

        // Detect default branch.
        let default_branch = detect_default_branch(&canonical);
        let branch_default_text = default_branch.clone().unwrap_or_else(|| "main".to_string());

        // Ask the user for the target branch, pre-filled with the detected default.
        let branch_prompt = format!("Target branch for '{}'", canonical.display());
        let branch_input = inquire::Text::new(&branch_prompt)
            .with_default(&branch_default_text)
            .prompt()?;
        let branch = branch_input.trim().to_string();

        // Validate the branch exists. Offer one retry on failure.
        if branch_exists(&canonical, &branch) {
            repos.push(RepoEntry {
                path: canonical,
                branch,
            });
            index += 1;
        } else {
            println!(
                "Branch '{}' does not exist in '{}'. Enter a different branch name (blank to skip this repo):",
                branch,
                canonical.display()
            );

            let retry_prompt = format!("Retry branch for '{}'", canonical.display());
            let retry_input = inquire::Text::new(&retry_prompt).prompt()?;
            let retry_branch = retry_input.trim().to_string();

            if retry_branch.is_empty() {
                println!("Skipping repo '{}'.", canonical.display());
                // Don't increment index; this repo slot is abandoned.
                continue;
            }

            if branch_exists(&canonical, &retry_branch) {
                repos.push(RepoEntry {
                    path: canonical,
                    branch: retry_branch,
                });
                index += 1;
            } else {
                println!(
                    "Branch '{}' also does not exist. Skipping repo '{}'.",
                    retry_branch,
                    canonical.display()
                );
            }
        }
    }

    Ok(repos)
}
