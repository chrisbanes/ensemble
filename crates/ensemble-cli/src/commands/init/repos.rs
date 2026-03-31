use std::path::PathBuf;
use std::process::Command;

/// Expand a leading `~` or `~/` to the user's home directory.
fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
}

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

/// Check whether a directory is a valid git repository (handles worktrees and submodules).
fn is_git_repo(repo_path: &PathBuf) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(repo_path)
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Check whether a branch exists in the given repository.
///
/// Accepts bare names (`main`), remote-qualified names (`origin/main`), or
/// full refnames (`refs/heads/main`). Checks local refs, remote refs under
/// `origin/`, and `refs/remotes/` directly so that `origin/main` resolves
/// to `refs/remotes/origin/main`.
fn branch_exists(repo_path: &PathBuf, branch: &str) -> bool {
    let candidates = [
        format!("refs/heads/{}", branch),
        format!("refs/remotes/origin/{}", branch),
        format!("refs/remotes/{}", branch),
    ];

    candidates.iter().any(|r| {
        Command::new("git")
            .args(["rev-parse", "--verify", r])
            .current_dir(repo_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    })
}

fn ask_branch_with_retry(repo_path: &PathBuf, initial_branch: &str) -> Option<String> {
    if branch_exists(repo_path, initial_branch) {
        return Some(initial_branch.to_string());
    }

    println!(
        "Branch '{}' does not exist in '{}'. Enter a different branch name (blank to skip this repo):",
        initial_branch,
        repo_path.display()
    );

    let retry_prompt = format!("Retry branch for '{}'", repo_path.display());
    let retry_input = inquire::Text::new(&retry_prompt).prompt().ok()?;
    let retry_branch = retry_input.trim().to_string();

    if retry_branch.is_empty() {
        return None;
    }

    if branch_exists(repo_path, &retry_branch) {
        Some(retry_branch)
    } else {
        println!(
            "Branch '{}' also does not exist. Skipping repo '{}'.",
            retry_branch,
            repo_path.display()
        );
        None
    }
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

        let expanded = expand_tilde(&trimmed);
        let input_path = PathBuf::from(&expanded);

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
        if !is_git_repo(&canonical) {
            println!(
                "'{}' does not appear to be a git repository. Please try again.",
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
        match ask_branch_with_retry(&canonical, &branch) {
            Some(branch) => {
                repos.push(RepoEntry {
                    path: canonical,
                    branch,
                });
                index += 1;
            }
            None => {
                println!("Skipping repo '{}'.", canonical.display());
            }
        }
    }

    Ok(repos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_with_slash() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_tilde("~/dev/ensemble"), format!("{home}/dev/ensemble"));
    }

    #[test]
    fn expand_tilde_bare() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_tilde("~"), home);
    }

    #[test]
    fn expand_tilde_no_tilde() {
        assert_eq!(expand_tilde("/usr/local/bin"), "/usr/local/bin");
    }

    #[test]
    fn expand_tilde_mid_path_unchanged() {
        assert_eq!(expand_tilde("/home/~user/foo"), "/home/~user/foo");
    }

    #[test]
    fn expand_tilde_tilde_user_unchanged() {
        // ~otheruser should NOT be expanded (we only handle ~/...)
        assert_eq!(expand_tilde("~otheruser/foo"), "~otheruser/foo");
    }

    #[test]
    fn branch_exists_local_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();

        // Init a repo with a commit so HEAD and main exist.
        Command::new("git").args(["init"]).current_dir(repo).output().unwrap();
        Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init"])
            .current_dir(repo)
            .output()
            .unwrap();

        let repo_path = PathBuf::from(repo);
        // Default branch should exist (could be main or master depending on config).
        let default = Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(repo)
            .output()
            .unwrap();
        let branch_name = String::from_utf8_lossy(&default.stdout).trim().to_string();

        assert!(branch_exists(&repo_path, &branch_name));
        assert!(!branch_exists(&repo_path, "nonexistent-branch-xyz"));
    }

    #[test]
    fn branch_exists_remote_qualified() {
        let tmp = tempfile::tempdir().unwrap();

        // Create a bare "remote" and clone it so we get origin refs.
        let bare = tmp.path().join("bare.git");
        Command::new("git")
            .args(["init", "--bare"])
            .arg(&bare)
            .output()
            .unwrap();

        let clone = tmp.path().join("clone");
        Command::new("git")
            .args(["clone"])
            .arg(&bare)
            .arg(&clone)
            .output()
            .unwrap();

        // Create initial commit and push so origin/main exists.
        Command::new("git")
            .args(["commit", "--allow-empty", "-m", "init"])
            .current_dir(&clone)
            .output()
            .unwrap();
        Command::new("git")
            .args(["push", "origin", "HEAD"])
            .current_dir(&clone)
            .output()
            .unwrap();

        let clone_path = PathBuf::from(&clone);
        let default = Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(&clone)
            .output()
            .unwrap();
        let branch_name = String::from_utf8_lossy(&default.stdout).trim().to_string();

        // "origin/main" should resolve via refs/remotes/origin/main
        let remote_qualified = format!("origin/{branch_name}");
        assert!(branch_exists(&clone_path, &remote_qualified));

        // Bare name should also work
        assert!(branch_exists(&clone_path, &branch_name));
    }
}
