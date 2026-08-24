use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::config::ensemble::{
    AffectedPathSource, ArtifactAccess, ArtifactSnapshotConfig, GateConfig, OnFailure,
    ResolvedOutputSchema, RouteConfig, StepApprovalConfig, StepAuthorizationConfig, StepConfig,
    StepKind,
};
use crate::error::PipelineError;

/// A single step in the resolved DAG, with its explicit dependency list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DagStep {
    pub name: String,
    pub agent: String,
    pub kind: StepKind,
    pub tracker_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    pub approval: Option<StepApprovalConfig>,
    pub on_failure: OnFailure,
    pub fixup_agent: Option<String>,
    #[serde(default)]
    pub resource_requests: BTreeMap<String, u32>,
    #[serde(default)]
    pub affected_paths: Option<AffectedPathSource>,
    #[serde(default)]
    pub output_schema: Option<ResolvedOutputSchema>,
    #[serde(default)]
    pub artifact_snapshot: Option<ArtifactSnapshotConfig>,
    #[serde(default)]
    pub artifact_inputs: Vec<String>,
    #[serde(default)]
    pub artifact_access: ArtifactAccess,
    #[serde(default)]
    pub gate: Option<GateConfig>,
    #[serde(default)]
    pub authorization: Option<StepAuthorizationConfig>,
    #[serde(default)]
    pub route: Option<RouteConfig>,
    pub depends: Vec<String>,
}

/// A validated, topologically-sorted step DAG.
///
/// `steps` is ordered such that every dependency appears before the steps
/// that depend on it (topological order). Use [`root_steps`] and
/// [`ready_steps`] to drive execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepDag {
    pub steps: Vec<DagStep>,
}

impl StepDag {
    /// Return `step_name` and every step that transitively depends on it.
    pub fn downstream_steps(&self, step_name: &str) -> HashSet<String> {
        let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
        for step in &self.steps {
            for dep in &step.depends {
                dependents
                    .entry(dep.as_str())
                    .or_default()
                    .push(step.name.as_str());
            }
        }

        let mut downstream = HashSet::new();
        let mut queue = VecDeque::from([step_name.to_string()]);

        while let Some(current) = queue.pop_front() {
            if !downstream.insert(current.clone()) {
                continue;
            }

            if let Some(next_steps) = dependents.get(current.as_str()) {
                for next in next_steps {
                    queue.push_back((*next).to_string());
                }
            }
        }

        downstream
    }
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
        let deps: Vec<String> = if let Some(ref explicit_deps) = step.depends {
            // Explicit deps (including empty vec for explicit roots) — validate references.
            for dep in explicit_deps {
                if !known.contains(dep.as_str()) {
                    return Err(PipelineError::UnknownDependency {
                        step: step.name.clone(),
                        dependency: dep.clone(),
                    });
                }
            }
            explicit_deps.clone()
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
            kind: step.kind,
            tracker_state: step.tracker_state.clone(),
            timeout_ms: step.timeout_ms,
            approval: step.approval.clone(),
            on_failure: step.on_failure,
            fixup_agent: step.fixup_agent.clone(),
            resource_requests: step.resource_requests.clone(),
            affected_paths: step.affected_paths.clone(),
            output_schema: step
                .output_schema
                .as_ref()
                .map(|config| {
                    let schema =
                        config
                            .schema
                            .clone()
                            .ok_or_else(|| PipelineError::InvalidStepConfig {
                                step: step.name.clone(),
                                reason:
                                    "output_schema was not resolved during configuration activation"
                                        .to_string(),
                            })?;
                    Ok(ResolvedOutputSchema { schema })
                })
                .transpose()?,
            artifact_snapshot: step.artifact_snapshot.clone(),
            artifact_inputs: step.artifact_inputs.clone(),
            artifact_access: step.artifact_access,
            gate: step.gate.clone(),
            authorization: step.authorization.clone(),
            route: step.route.clone(),
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
    use crate::config::ensemble::StepKind;

    fn make_step(name: &str, agent: &str, depends: &[&str]) -> StepConfig {
        let deps = if depends.is_empty() {
            None // implicit sequential
        } else {
            Some(depends.iter().map(|s| s.to_string()).collect())
        };
        StepConfig {
            name: name.to_string(),
            kind: StepKind::Agent,
            agent: agent.to_string(),
            depends: deps,
            tracker_state: None,
            timeout_ms: None,
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
            resource_requests: Default::default(),
            affected_paths: None,
            output_schema: None,
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
            gate: None,
            authorization: None,
            route: None,
        }
    }

    fn make_root_step(name: &str, agent: &str) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            kind: StepKind::Agent,
            agent: agent.to_string(),
            depends: Some(vec![]), // explicit root
            tracker_state: None,
            timeout_ms: None,
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
            resource_requests: Default::default(),
            affected_paths: None,
            output_schema: None,
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
            gate: None,
            authorization: None,
            route: None,
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

    #[test]
    fn test_explicit_parallel_roots() {
        // Two steps both explicitly declared as roots via depends: []
        let steps = vec![
            make_root_step("lint", "linter"),
            make_root_step("build", "builder"),
            make_step("test", "tester", &["lint", "build"]),
        ];
        let dag = build_dag(&steps).unwrap();
        let roots = root_steps(&dag);
        assert!(roots.contains(&"lint"));
        assert!(roots.contains(&"build"));
        assert!(!roots.contains(&"test"));
    }

    #[test]
    fn test_dag_preserves_synthesis_kind() {
        let steps = vec![
            StepConfig {
                name: "review-a".to_string(),
                kind: StepKind::Agent,
                agent: "reviewer".to_string(),
                depends: Some(vec![]),
                tracker_state: None,
                timeout_ms: None,
                approval: None,
                on_failure: OnFailure::RetryIssue,
                fixup_agent: None,
                resource_requests: Default::default(),
                affected_paths: None,
                output_schema: None,
                artifact_snapshot: None,
                artifact_inputs: Vec::new(),
                artifact_access: Default::default(),
                gate: None,
                authorization: None,
                route: None,
            },
            StepConfig {
                name: "synthesize".to_string(),
                kind: StepKind::Synthesis,
                agent: "synth".to_string(),
                depends: Some(vec!["review-a".to_string()]),
                tracker_state: None,
                timeout_ms: None,
                approval: None,
                on_failure: OnFailure::RetryIssue,
                fixup_agent: None,
                resource_requests: Default::default(),
                affected_paths: None,
                output_schema: None,
                artifact_snapshot: None,
                artifact_inputs: Vec::new(),
                artifact_access: Default::default(),
                gate: None,
                authorization: None,
                route: None,
            },
        ];

        let dag = build_dag(&steps).unwrap();
        let synth = dag
            .steps
            .iter()
            .find(|step| step.name == "synthesize")
            .unwrap();

        assert_eq!(synth.kind, StepKind::Synthesis);
    }

    #[test]
    fn build_dag_preserves_step_timeout_ms() {
        let steps = vec![StepConfig {
            name: "build".to_string(),
            kind: StepKind::Agent,
            agent: "builder".to_string(),
            depends: Some(vec![]),
            tracker_state: None,
            timeout_ms: Some(120_000),
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
            resource_requests: Default::default(),
            affected_paths: None,
            output_schema: None,
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
            gate: None,
            authorization: None,
            route: None,
        }];

        let dag = build_dag(&steps).unwrap();

        assert_eq!(dag.steps[0].timeout_ms, Some(120_000));
    }

    #[test]
    fn preserves_step_approval_metadata() {
        let steps = vec![StepConfig {
            name: "plan".to_string(),
            kind: StepKind::Agent,
            agent: "planner".to_string(),
            depends: None,
            tracker_state: Some("Planning".to_string()),
            timeout_ms: None,
            approval: Some(StepApprovalConfig {
                mode: crate::config::ensemble::StepApprovalMode::WhenRequestedByAgent,
                state: Some("Plan Review".to_string()),
            }),
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
            resource_requests: Default::default(),
            affected_paths: None,
            output_schema: None,
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
            gate: None,
            authorization: None,
            route: None,
        }];

        let dag = build_dag(&steps).unwrap();
        let plan = dag.steps.iter().find(|s| s.name == "plan").unwrap();

        let approval = plan
            .approval
            .as_ref()
            .expect("approval metadata should be preserved");
        assert_eq!(
            approval.mode,
            crate::config::ensemble::StepApprovalMode::WhenRequestedByAgent
        );
        assert_eq!(approval.state.as_deref(), Some("Plan Review"));
    }

    #[test]
    fn preserves_on_failure_metadata() {
        let steps = vec![StepConfig {
            name: "build".to_string(),
            kind: StepKind::Agent,
            agent: "builder".to_string(),
            depends: None,
            tracker_state: None,
            timeout_ms: None,
            approval: None,
            on_failure: OnFailure::Fixup,
            fixup_agent: Some("fixer".to_string()),
            resource_requests: Default::default(),
            affected_paths: None,
            output_schema: None,
            artifact_snapshot: None,
            artifact_inputs: Vec::new(),
            artifact_access: Default::default(),
            gate: None,
            authorization: None,
            route: None,
        }];

        let dag = build_dag(&steps).unwrap();
        let build = dag.steps.iter().find(|s| s.name == "build").unwrap();

        assert_eq!(build.on_failure, OnFailure::Fixup);
        assert_eq!(build.fixup_agent.as_deref(), Some("fixer"));
    }

    #[test]
    fn downstream_steps_for_linear_chain_includes_middle_and_tail() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("test", "tester", &[]),
            make_step("review", "reviewer", &[]),
        ];
        let dag = build_dag(&steps).unwrap();

        let downstream = dag.downstream_steps("test");

        assert_eq!(
            downstream,
            HashSet::from(["test".to_string(), "review".to_string()])
        );
    }

    #[test]
    fn downstream_steps_for_diamond_excludes_sibling_branch() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review-a", "reviewer", &["build"]),
            make_step("review-b", "reviewer", &["build"]),
            make_step("synth", "synthesizer", &["review-a", "review-b"]),
        ];
        let dag = build_dag(&steps).unwrap();

        let downstream = dag.downstream_steps("review-a");

        assert_eq!(
            downstream,
            HashSet::from(["review-a".to_string(), "synth".to_string()])
        );
    }

    #[test]
    fn downstream_steps_for_root_in_sequential_graph_includes_all_steps() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("test", "tester", &[]),
            make_step("review", "reviewer", &[]),
        ];
        let dag = build_dag(&steps).unwrap();

        let downstream = dag.downstream_steps("build");

        assert_eq!(
            downstream,
            HashSet::from([
                "build".to_string(),
                "test".to_string(),
                "review".to_string()
            ])
        );
    }

    #[test]
    fn downstream_steps_for_leaf_returns_only_itself() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("test", "tester", &[]),
            make_step("review", "reviewer", &[]),
        ];
        let dag = build_dag(&steps).unwrap();

        let downstream = dag.downstream_steps("review");

        assert_eq!(downstream, HashSet::from(["review".to_string()]));
    }
}
