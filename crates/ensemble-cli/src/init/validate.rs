use crate::init::agents::AgentEntry;
use crate::init::pipeline::PipelineStep;
use crate::init::repos::RepoEntry;
use crate::init::tracker::TrackerChoice;

#[derive(Debug)]
struct CheckResult {
    label: String,
    passed: bool,
    detail: String,
}

pub async fn run_validation(
    tracker: &TrackerChoice,
    repos: &[RepoEntry],
    agents: &[AgentEntry],
    steps: &[PipelineStep],
) -> bool {
    println!("\nValidating configuration...\n");

    let mut checks = Vec::new();

    let acpx_ok = std::process::Command::new("acpx")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    checks.push(CheckResult {
        label: "acpx".to_string(),
        passed: acpx_ok,
        detail: if acpx_ok {
            "installed".to_string()
        } else {
            "not found on PATH".to_string()
        },
    });

    match tracker {
        TrackerChoice::GitHub {
            repository,
            project_number,
            ..
        } => {
            let detail = match project_number {
                Some(n) => format!("GitHub Projects #{n} on {repository}"),
                None => format!("GitHub repo {repository}"),
            };
            checks.push(CheckResult {
                label: "Tracker".to_string(),
                passed: true,
                detail,
            });
        }
        TrackerChoice::TodoFile { path } => {
            checks.push(CheckResult {
                label: "Tracker".to_string(),
                passed: true,
                detail: format!("TODO.md at {}", path.display()),
            });
        }
    }

    for repo in repos {
        let exists = repo.path.join(".git").exists();
        let branch_ok = std::process::Command::new("git")
            .args([
                "rev-parse",
                "--verify",
                &format!("refs/heads/{}", repo.branch),
            ])
            .current_dir(&repo.path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        let passed = exists && branch_ok;
        let detail = if passed {
            format!("{} (git, branch: {})", repo.path.display(), repo.branch)
        } else if !exists {
            format!("{} — not a git repo", repo.path.display())
        } else {
            format!(
                "{} — branch '{}' not found",
                repo.path.display(),
                repo.branch
            )
        };

        checks.push(CheckResult {
            label: "Repo".to_string(),
            passed,
            detail,
        });
    }

    for agent in agents {
        let healthy = std::process::Command::new("acpx")
            .args(["--agent", &agent.acpx_agent, "--version"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        checks.push(CheckResult {
            label: format!("Agent: {}", agent.role),
            passed: healthy,
            detail: if healthy {
                format!("{}, healthy via acpx", agent.acpx_agent)
            } else {
                format!("{}, health check failed", agent.acpx_agent)
            },
        });
    }

    let dag_ok = validate_dag(steps);
    checks.push(CheckResult {
        label: "Pipeline".to_string(),
        passed: dag_ok,
        detail: format!(
            "{} steps, {}",
            steps.len(),
            if dag_ok {
                "no cycles"
            } else {
                "CYCLE DETECTED"
            }
        ),
    });

    let mut failures = 0;
    for check in &checks {
        let icon = if check.passed { "✓" } else { "✗" };
        println!("  {icon} {:<16} {}", check.label, check.detail);
        if !check.passed {
            failures += 1;
        }
    }

    println!();

    if failures == 0 {
        println!("All checks passed! ✓\n");
        return true;
    }

    println!("{failures} check(s) failed.");

    inquire::Confirm::new("Write config anyway?")
        .with_default(false)
        .prompt()
        .is_ok_and(|v| v)
}

fn validate_dag(steps: &[PipelineStep]) -> bool {
    use std::collections::{HashMap, HashSet, VecDeque};

    if steps.is_empty() {
        return false;
    }

    let names: HashSet<&str> = steps.iter().map(|s| s.name.as_str()).collect();
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();

    for step in steps {
        in_degree.entry(step.name.as_str()).or_insert(0);
        for dep in &step.depends {
            if !names.contains(dep.as_str()) {
                return false;
            }
            adj.entry(dep.as_str())
                .or_default()
                .push(step.name.as_str());
            *in_degree.entry(step.name.as_str()).or_insert(0) += 1;
        }
    }

    let mut queue: VecDeque<&str> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&name, _)| name)
        .collect();

    let mut visited = 0;
    while let Some(node) = queue.pop_front() {
        visited += 1;
        if let Some(deps) = adj.get(node) {
            for &next in deps {
                let deg = in_degree.get_mut(next).unwrap();
                *deg -= 1;
                if *deg == 0 {
                    queue.push_back(next);
                }
            }
        }
    }

    visited == steps.len()
}
