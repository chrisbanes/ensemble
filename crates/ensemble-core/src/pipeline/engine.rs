use std::collections::{HashMap, HashSet};

use crate::pipeline::dag::StepDag;
use crate::pipeline::verdict::Verdict;

/// The execution state of a single pipeline step.
#[derive(Debug, Clone, PartialEq)]
pub enum StepState {
    /// Step has not started yet.
    Pending,
    /// Step is currently executing in the given session.
    Running { session_id: String },
    /// Step completed and was approved.
    Passed,
    /// Step completed but was rejected by a review agent.
    Rejected { summary: String },
    /// Step failed due to an agent crash or runtime error.
    Failed { error: String },
}

impl StepState {
    /// Returns `true` if the step is in a terminal state (no further
    /// transitions are possible).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Passed | Self::Rejected { .. } | Self::Failed { .. }
        )
    }
}

/// A request for the orchestrator to dispatch a step to an agent.
#[derive(Debug, Clone, PartialEq)]
pub struct DispatchRequest {
    /// The name of the step to dispatch.
    pub step_name: String,
    /// The name of the agent that should execute this step.
    pub agent_name: String,
    /// Optional tracker state to set while the step is running.
    pub tracker_state: Option<String>,
}

/// The action the orchestrator should take after a state transition.
#[derive(Debug, Clone, PartialEq)]
pub enum PipelineAction {
    /// Dispatch these steps to their respective agents.
    Dispatch(Vec<DispatchRequest>),
    /// All steps have passed — pipeline completed successfully.
    Succeeded,
    /// A step failed or was rejected — pipeline halted.
    Failed { step: String, reason: String },
    /// No steps are ready right now; waiting for running steps to finish.
    Waiting,
}

/// Per-issue pipeline execution state machine.
///
/// Tracks step states, drives step dispatch when dependencies are met, and
/// determines the next action the orchestrator should take after each event.
#[derive(Debug, Clone)]
pub struct PipelineRun {
    /// The issue this pipeline run is associated with.
    pub issue_id: String,
    /// The current cycle number (incremented on retry).
    pub cycle: u32,
    /// Current state of each step, keyed by step name.
    pub step_states: HashMap<String, StepState>,
    /// The resolved, validated step DAG.
    dag: StepDag,
}

impl PipelineRun {
    /// Create a new `PipelineRun` for the given issue, initialising all steps
    /// as [`StepState::Pending`].
    pub fn new(issue_id: String, cycle: u32, dag: StepDag) -> Self {
        let step_states = dag
            .steps
            .iter()
            .map(|s| (s.name.clone(), StepState::Pending))
            .collect();
        Self {
            issue_id,
            cycle,
            step_states,
            dag,
        }
    }

    /// Compute the initial dispatch action — all root steps (no dependencies)
    /// are ready to run immediately.
    pub fn start(&self) -> PipelineAction {
        self.find_dispatchable()
    }

    /// Record that a step has been dispatched and is now running in the given
    /// session.
    pub fn mark_running(&mut self, step_name: &str, session_id: String) {
        self.step_states
            .insert(step_name.to_string(), StepState::Running { session_id });
    }

    /// Handle a completed step verdict.
    ///
    /// - [`Verdict::Approve`] → marks the step as [`StepState::Passed`] and
    ///   checks whether all steps are done or if new steps can be dispatched.
    /// - [`Verdict::Reject`] → marks the step as [`StepState::Rejected`] and
    ///   returns [`PipelineAction::Failed`].
    pub fn step_completed(&mut self, step_name: &str, verdict: Verdict) -> PipelineAction {
        match verdict {
            Verdict::Approve => {
                self.step_states
                    .insert(step_name.to_string(), StepState::Passed);
                if self.all_passed() {
                    PipelineAction::Succeeded
                } else {
                    self.find_dispatchable()
                }
            }
            Verdict::Reject { summary } => {
                self.step_states.insert(
                    step_name.to_string(),
                    StepState::Rejected {
                        summary: summary.clone(),
                    },
                );
                PipelineAction::Failed {
                    step: step_name.to_string(),
                    reason: summary,
                }
            }
        }
    }

    /// Handle a step that failed due to a runtime error.
    ///
    /// Marks the step as [`StepState::Failed`] and returns
    /// [`PipelineAction::Failed`].
    pub fn step_failed(&mut self, step_name: &str, error: String) -> PipelineAction {
        self.step_states.insert(
            step_name.to_string(),
            StepState::Failed {
                error: error.clone(),
            },
        );
        PipelineAction::Failed {
            step: step_name.to_string(),
            reason: error,
        }
    }

    /// Returns `true` when every step in the DAG is in the
    /// [`StepState::Passed`] state.
    fn all_passed(&self) -> bool {
        self.dag
            .steps
            .iter()
            .all(|s| self.step_states.get(&s.name) == Some(&StepState::Passed))
    }

    /// Find all steps that are [`StepState::Pending`] and whose dependencies
    /// are all [`StepState::Passed`].
    ///
    /// Returns [`PipelineAction::Dispatch`] with the ready steps, or
    /// [`PipelineAction::Waiting`] if nothing is currently dispatchable.
    fn find_dispatchable(&self) -> PipelineAction {
        let passed: HashSet<String> = self
            .dag
            .steps
            .iter()
            .filter(|s| self.step_states.get(&s.name) == Some(&StepState::Passed))
            .map(|s| s.name.clone())
            .collect();

        let requests: Vec<DispatchRequest> = self
            .dag
            .steps
            .iter()
            .filter(|s| {
                self.step_states.get(&s.name) == Some(&StepState::Pending)
                    && s.depends.iter().all(|dep| passed.contains(dep))
            })
            .map(|s| DispatchRequest {
                step_name: s.name.clone(),
                agent_name: s.agent.clone(),
                tracker_state: s.tracker_state.clone(),
            })
            .collect();

        if requests.is_empty() {
            PipelineAction::Waiting
        } else {
            PipelineAction::Dispatch(requests)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::StepConfig;
    use crate::pipeline::dag::build_dag;

    fn make_step(name: &str, agent: &str, depends: &[&str]) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: depends.iter().map(|s| s.to_string()).collect(),
            tracker_state: None,
        }
    }

    fn make_step_with_state(
        name: &str,
        agent: &str,
        depends: &[&str],
        tracker_state: &str,
    ) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: depends.iter().map(|s| s.to_string()).collect(),
            tracker_state: Some(tracker_state.to_string()),
        }
    }

    /// Build a `PipelineRun` from a slice of `StepConfig` entries.
    fn make_run(steps: &[StepConfig]) -> PipelineRun {
        let dag = build_dag(steps).unwrap();
        PipelineRun::new("issue-1".to_string(), 1, dag)
    }

    // -------------------------------------------------------------------------
    // test_sequential_pipeline
    // -------------------------------------------------------------------------

    #[test]
    fn test_sequential_pipeline() {
        // build → test (implicit sequential dependency)
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("test", "tester", &[]),
        ];
        let mut run = make_run(&steps);

        // start() should dispatch only the root step (build).
        let action = run.start();
        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "build"),
            "expected Dispatch([build]), got {action:?}"
        );

        // Mark build as running.
        run.mark_running("build", "session-1".to_string());
        assert_eq!(
            run.step_states["build"],
            StepState::Running {
                session_id: "session-1".to_string()
            }
        );

        // build completes with approve → should dispatch test next.
        let action = run.step_completed("build", Verdict::Approve);
        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "test"),
            "expected Dispatch([test]), got {action:?}"
        );

        run.mark_running("test", "session-2".to_string());

        // test completes with approve → all done.
        let action = run.step_completed("test", Verdict::Approve);
        assert_eq!(action, PipelineAction::Succeeded);
    }

    // -------------------------------------------------------------------------
    // test_parallel_review
    // -------------------------------------------------------------------------

    #[test]
    fn test_parallel_review() {
        // build → review-a + review-b (both depend on build explicitly)
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review-a", "reviewer", &["build"]),
            make_step("review-b", "reviewer", &["build"]),
        ];
        let mut run = make_run(&steps);

        // Only build should be dispatched initially.
        let action = run.start();
        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "build"),
            "expected only build to be dispatched initially, got {action:?}"
        );

        run.mark_running("build", "session-build".to_string());
        let action = run.step_completed("build", Verdict::Approve);

        // After build passes, both review steps should be dispatched together.
        match action {
            PipelineAction::Dispatch(mut reqs) => {
                assert_eq!(reqs.len(), 2, "expected 2 review steps dispatched");
                reqs.sort_by(|a, b| a.step_name.cmp(&b.step_name));
                assert_eq!(reqs[0].step_name, "review-a");
                assert_eq!(reqs[1].step_name, "review-b");
            }
            other => panic!("expected Dispatch, got {other:?}"),
        }

        // Both reviews pass → Succeeded.
        run.mark_running("review-a", "session-ra".to_string());
        run.mark_running("review-b", "session-rb".to_string());
        let _ = run.step_completed("review-a", Verdict::Approve);
        // After review-a passes, review-b is still running → Waiting.
        let _action = run.step_completed("review-a", Verdict::Approve);
        // review-a was already set to Passed; a second approve on it should
        // still produce Waiting (review-b still pending/running).
        // Restart properly: create a fresh run and walk through fully.
        let steps2 = vec![
            make_step("build", "builder", &[]),
            make_step("review-a", "reviewer", &["build"]),
            make_step("review-b", "reviewer", &["build"]),
        ];
        let mut run2 = make_run(&steps2);
        run2.mark_running("build", "s-b".to_string());
        run2.step_completed("build", Verdict::Approve);
        run2.mark_running("review-a", "s-ra".to_string());
        run2.mark_running("review-b", "s-rb".to_string());

        // review-a passes first; review-b is still Running → Waiting.
        let action = run2.step_completed("review-a", Verdict::Approve);
        assert_eq!(
            action,
            PipelineAction::Waiting,
            "expected Waiting while review-b still running, got {action:?}"
        );

        // Now review-b also passes → Succeeded.
        let action = run2.step_completed("review-b", Verdict::Approve);
        assert_eq!(action, PipelineAction::Succeeded);
    }

    // -------------------------------------------------------------------------
    // test_rejection_halts_pipeline
    // -------------------------------------------------------------------------

    #[test]
    fn test_rejection_halts_pipeline() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &[]),
        ];
        let mut run = make_run(&steps);

        run.mark_running("build", "s-b".to_string());
        run.step_completed("build", Verdict::Approve);
        run.mark_running("review", "s-r".to_string());

        let action = run.step_completed(
            "review",
            Verdict::Reject {
                summary: "code quality is too low".to_string(),
            },
        );

        assert!(
            matches!(
                &action,
                PipelineAction::Failed { step, reason }
                    if step == "review" && reason == "code quality is too low"
            ),
            "expected Failed for rejected review, got {action:?}"
        );

        // Step state should reflect rejection.
        assert!(matches!(
            &run.step_states["review"],
            StepState::Rejected { summary } if summary == "code quality is too low"
        ));
    }

    // -------------------------------------------------------------------------
    // test_step_failure_halts_pipeline
    // -------------------------------------------------------------------------

    #[test]
    fn test_step_failure_halts_pipeline() {
        let steps = vec![make_step("build", "builder", &[])];
        let mut run = make_run(&steps);

        run.mark_running("build", "s-b".to_string());

        let action = run.step_failed("build", "agent crashed with exit code 1".to_string());

        assert!(
            matches!(
                &action,
                PipelineAction::Failed { step, reason }
                    if step == "build" && reason == "agent crashed with exit code 1"
            ),
            "expected Failed for crashed agent, got {action:?}"
        );

        assert!(matches!(
            &run.step_states["build"],
            StepState::Failed { error } if error == "agent crashed with exit code 1"
        ));
    }

    // -------------------------------------------------------------------------
    // test_tracker_state_in_dispatch
    // -------------------------------------------------------------------------

    #[test]
    fn test_tracker_state_in_dispatch() {
        let steps = vec![
            make_step_with_state("build", "builder", &[], "Building"),
            make_step_with_state("review", "reviewer", &[], "In Review"),
        ];
        let mut run = make_run(&steps);

        // start() dispatches build; its tracker_state should be "Building".
        let action = run.start();
        match &action {
            PipelineAction::Dispatch(reqs) => {
                assert_eq!(reqs.len(), 1);
                assert_eq!(reqs[0].step_name, "build");
                assert_eq!(reqs[0].tracker_state.as_deref(), Some("Building"));
            }
            other => panic!("expected Dispatch, got {other:?}"),
        }

        // After build passes, review is dispatched with its tracker_state.
        run.mark_running("build", "s-b".to_string());
        let action = run.step_completed("build", Verdict::Approve);
        match &action {
            PipelineAction::Dispatch(reqs) => {
                assert_eq!(reqs.len(), 1);
                assert_eq!(reqs[0].step_name, "review");
                assert_eq!(reqs[0].tracker_state.as_deref(), Some("In Review"));
            }
            other => panic!("expected Dispatch for review, got {other:?}"),
        }
    }

    // -------------------------------------------------------------------------
    // test_is_terminal
    // -------------------------------------------------------------------------

    #[test]
    fn test_is_terminal() {
        assert!(!StepState::Pending.is_terminal());
        assert!(!StepState::Running {
            session_id: "x".to_string()
        }
        .is_terminal());
        assert!(StepState::Passed.is_terminal());
        assert!(StepState::Rejected {
            summary: "nope".to_string()
        }
        .is_terminal());
        assert!(StepState::Failed {
            error: "boom".to_string()
        }
        .is_terminal());
    }
}
