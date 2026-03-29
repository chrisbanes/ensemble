use std::collections::{HashMap, HashSet, VecDeque};

use crate::config::ensemble::StepConfig;
use crate::error::PipelineError;

/// A single step in the resolved DAG, with its explicit dependency list.
#[derive(Debug, Clone, PartialEq)]
pub struct DagStep {
    pub name: String,
    pub agent: String,
    pub tracker_state: Option<String>,
    pub depends: Vec<String>,
}

/// A validated, topologically-sorted step DAG.
///
/// `steps` is ordered such that every dependency appears before the steps
/// that depend on it (topological order). Use [`root_steps`] and
/// [`ready_steps`] to drive execution.
#[derive(Debug, Clone)]
pub struct StepDag {
    pub steps: Vec<DagStep>,
}

/// Build a [`StepDag`] from a slice of [`StepConfig`] entries.
///
/// **Implicit sequential rule:** the first step in the list is a root (no
/// implicit deps). Each subsequent step that omits `depends` implicitly
/// depends on the step directly before it. An explicit (non-empty) `depends`
/// list overrides this — the step's deps are exactly what was specified.
///
/// Returns [`PipelineError::NoRootSteps`] for an empty input, and
/// [`PipelineError::UnknownDependency`] or [`PipelineError::CycleDetected`]
/// for structural problems.
pub fn build_dag(steps: &[StepConfig]) -> Result<StepDag, PipelineError> {
    if steps.is_empty() {
        return Err(PipelineError::NoRootSteps);
    }

    // Build a set of known step names for validation.
    let known: HashSet<&str> = steps.iter().map(|s| s.name.as_str()).collect();

    // Resolve each step's dependency list, applying the implicit sequential rule.
    let mut resolved: Vec<DagStep> = Vec::with_capacity(steps.len());
    for (i, step) in steps.iter().enumerate() {
        let deps: Vec<String> = if !step.depends.is_empty() {
            // Explicit deps — validate all references exist.
            for dep in &step.depends {
                if !known.contains(dep.as_str()) {
                    return Err(PipelineError::UnknownDependency {
                        step: step.name.clone(),
                        dependency: dep.clone(),
                    });
                }
            }
            step.depends.clone()
        } else if i > 0 {
            // Implicit sequential: depend on the previous step.
            vec![steps[i - 1].name.clone()]
        } else {
            // First step — root, no deps.
            vec![]
        };

        // Detect self-cycle early.
        if deps.contains(&step.name) {
            return Err(PipelineError::CycleDetected);
        }

        resolved.push(DagStep {
            name: step.name.clone(),
            agent: step.agent.clone(),
            tracker_state: step.tracker_state.clone(),
            depends: deps,
        });
    }

    // Kahn's algorithm for topological sort and cycle detection.
    // Build adjacency and in-degree maps keyed by step name.
    let name_to_idx: HashMap<&str, usize> = resolved
        .iter()
        .enumerate()
        .map(|(i, s)| (s.name.as_str(), i))
        .collect();

    let mut in_degree: Vec<usize> = vec![0; resolved.len()];
    // edges[i] = list of step indices that depend on step i
    let mut edges: Vec<Vec<usize>> = vec![Vec::new(); resolved.len()];

    for (idx, step) in resolved.iter().enumerate() {
        for dep in &step.depends {
            let dep_idx = *name_to_idx.get(dep.as_str()).unwrap(); // already validated
            edges[dep_idx].push(idx);
            in_degree[idx] += 1;
        }
    }

    // Enqueue all steps with in-degree 0 (roots).
    let mut queue: VecDeque<usize> = in_degree
        .iter()
        .enumerate()
        .filter(|(_, &d)| d == 0)
        .map(|(i, _)| i)
        .collect();

    let mut sorted: Vec<DagStep> = Vec::with_capacity(resolved.len());

    while let Some(idx) = queue.pop_front() {
        sorted.push(resolved[idx].clone());
        for &next in &edges[idx] {
            in_degree[next] -= 1;
            if in_degree[next] == 0 {
                queue.push_back(next);
            }
        }
    }

    if sorted.len() != resolved.len() {
        return Err(PipelineError::CycleDetected);
    }

    Ok(StepDag { steps: sorted })
}

/// Return the names of all steps that have no dependencies (roots of the DAG).
pub fn root_steps(dag: &StepDag) -> Vec<&str> {
    dag.steps
        .iter()
        .filter(|s| s.depends.is_empty())
        .map(|s| s.name.as_str())
        .collect()
}

/// Return the names of steps whose dependencies are all in `completed` and
/// that are not themselves already in `completed`.
pub fn ready_steps<'a>(dag: &'a StepDag, completed: &HashSet<String>) -> Vec<&'a str> {
    dag.steps
        .iter()
        .filter(|s| {
            !completed.contains(&s.name) && s.depends.iter().all(|dep| completed.contains(dep))
        })
        .map(|s| s.name.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_step(name: &str, agent: &str, depends: &[&str]) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: depends.iter().map(|s| s.to_string()).collect(),
            tracker_state: None,
        }
    }

    #[test]
    fn test_sequential_implicit_deps() {
        // 3 steps with no explicit depends → a chain a → b → c
        let steps = vec![
            make_step("a", "agent1", &[]),
            make_step("b", "agent1", &[]),
            make_step("c", "agent1", &[]),
        ];
        let dag = build_dag(&steps).unwrap();
        assert_eq!(dag.steps.len(), 3);

        let a = dag.steps.iter().find(|s| s.name == "a").unwrap();
        let b = dag.steps.iter().find(|s| s.name == "b").unwrap();
        let c = dag.steps.iter().find(|s| s.name == "c").unwrap();

        assert!(a.depends.is_empty(), "a should be a root");
        assert_eq!(b.depends, vec!["a"], "b should implicitly depend on a");
        assert_eq!(c.depends, vec!["b"], "c should implicitly depend on b");
    }

    #[test]
    fn test_explicit_depends_parallel() {
        // build + 2 review steps both depending on build
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review1", "reviewer", &["build"]),
            make_step("review2", "reviewer", &["build"]),
        ];
        let dag = build_dag(&steps).unwrap();
        assert_eq!(dag.steps.len(), 3);

        let review1 = dag.steps.iter().find(|s| s.name == "review1").unwrap();
        let review2 = dag.steps.iter().find(|s| s.name == "review2").unwrap();

        assert_eq!(review1.depends, vec!["build"]);
        assert_eq!(review2.depends, vec!["build"]);
    }

    #[test]
    fn test_cycle_detected() {
        // a depends on b, b depends on a
        let steps = vec![
            make_step("a", "agent", &["b"]),
            make_step("b", "agent", &["a"]),
        ];
        let result = build_dag(&steps);
        assert!(
            matches!(result, Err(PipelineError::CycleDetected)),
            "expected CycleDetected, got {result:?}"
        );
    }

    #[test]
    fn test_unknown_dependency() {
        // step depends on a nonexistent step
        let steps = vec![make_step("a", "agent", &["nonexistent"])];
        let result = build_dag(&steps);
        assert!(
            matches!(
                result,
                Err(PipelineError::UnknownDependency {
                    ref step,
                    ref dependency
                }) if step == "a" && dependency == "nonexistent"
            ),
            "expected UnknownDependency, got {result:?}"
        );
    }

    #[test]
    fn test_empty_steps() {
        let result = build_dag(&[]);
        assert!(
            matches!(result, Err(PipelineError::NoRootSteps)),
            "expected NoRootSteps, got {result:?}"
        );
    }

    #[test]
    fn test_root_steps() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review1", "reviewer", &["build"]),
            make_step("review2", "reviewer", &["build"]),
        ];
        let dag = build_dag(&steps).unwrap();
        let roots = root_steps(&dag);
        assert_eq!(roots, vec!["build"]);
    }

    #[test]
    fn test_ready_steps_after_completion() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review1", "reviewer", &["build"]),
            make_step("review2", "reviewer", &["build"]),
        ];
        let dag = build_dag(&steps).unwrap();

        // Initially only build is ready (no deps).
        let completed = HashSet::new();
        let mut ready = ready_steps(&dag, &completed);
        ready.sort();
        assert_eq!(ready, vec!["build"]);

        // After build completes, both reviews become ready.
        let mut completed = HashSet::new();
        completed.insert("build".to_string());
        let mut ready = ready_steps(&dag, &completed);
        ready.sort();
        assert_eq!(ready, vec!["review1", "review2"]);
    }

    #[test]
    fn test_self_cycle() {
        // step depends on itself
        let steps = vec![make_step("a", "agent", &["a"])];
        let result = build_dag(&steps);
        assert!(
            matches!(result, Err(PipelineError::CycleDetected)),
            "expected CycleDetected for self-dep, got {result:?}"
        );
    }
}
