use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::pipeline::dag::StepDag;
use crate::pipeline::verdict::{StepOutput, Verdict};

/// The execution state of a single pipeline step.
#[derive(Debug, Clone, PartialEq)]
pub enum StepState {
    /// Step has not started yet.
    Pending,
    /// Step is currently executing in the given session.
    Running { session_id: String },
    /// Step is waiting for a human interaction response before it can resume.
    BlockedOnHuman { interaction_request_id: String },
    /// Step is waiting for approval on a completed result before downstream
    /// work can continue.
    AwaitingApproval {
        interaction_request_id: Option<String>,
    },
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
    /// A step is blocked pending a human interaction response.
    BlockedOnHuman {
        step: String,
        interaction_request_id: String,
    },
    /// A step has completed but is waiting for approval before downstream
    /// steps may be dispatched.
    AwaitingApproval {
        step: String,
        approval_state: Option<String>,
    },
    /// All steps have passed — pipeline completed successfully.
    Succeeded,
    /// A step failed or was rejected — pipeline halted.
    Failed { step: String, reason: String },
    /// No steps are ready right now; waiting for running steps to finish.
    Waiting,
}

/// Result of checking whether a step is eligible for post-step approval gating.
#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalGateCheck {
    /// Step is eligible — approval gate should apply.
    EligibleGating,
    /// Step has no approval config and none was requested.
    NotRequested,
    /// Worker emitted an approval request but the step has no approval
    /// configuration. This is a mismatch that should fail the step.
    UnconfiguredButRequested,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StepOutputTemplateEntry {
    pub step: String,
    pub verdict: String,
    pub summary: Option<String>,
    pub output: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StepOutputTemplateContext {
    pub steps: HashMap<String, StepOutputTemplateEntry>,
    pub dependency_outputs: Vec<StepOutputTemplateEntry>,
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
    /// Stored outputs from completed steps.
    pub step_outputs: HashMap<String, StepOutput>,
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
            step_outputs: HashMap::new(),
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
    /// - [`Verdict::Approve`] → either transitions to
    ///   [`PipelineAction::AwaitingApproval`] for approval-gated steps, or
    ///   marks the step as [`StepState::Passed`] and checks whether all steps
    ///   are done or if new steps can be dispatched.
    /// - [`Verdict::Reject`] → marks the step as [`StepState::Rejected`] and
    ///   returns [`PipelineAction::Failed`].
    pub fn step_completed(
        &mut self,
        step_name: &str,
        output: StepOutput,
        approval_requested: bool,
    ) -> PipelineAction {
        let verdict = output.verdict.clone();
        self.step_outputs.insert(step_name.to_string(), output);
        match verdict {
            Verdict::Approve => match self.gate_check(step_name, approval_requested) {
                ApprovalGateCheck::EligibleGating => {
                    let approval_state = self.approval_state_for(step_name);
                    self.step_states.insert(
                        step_name.to_string(),
                        StepState::AwaitingApproval {
                            interaction_request_id: None,
                        },
                    );
                    PipelineAction::AwaitingApproval {
                        step: step_name.to_string(),
                        approval_state,
                    }
                }
                ApprovalGateCheck::UnconfiguredButRequested => {
                    self.step_states.insert(
                            step_name.to_string(),
                            StepState::Failed {
                                error: format!(
                                    "worker requested approval for step '{step_name}' but it has no approval configuration"
                                ),
                            },
                        );
                    PipelineAction::Failed {
                            step: step_name.to_string(),
                            reason: format!(
                                "step '{step_name}' has no approval configuration but the worker requested one"
                            ),
                        }
                }
                ApprovalGateCheck::NotRequested => {
                    self.step_states
                        .insert(step_name.to_string(), StepState::Passed);
                    if self.all_passed() {
                        PipelineAction::Succeeded
                    } else {
                        self.find_dispatchable()
                    }
                }
            },
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

    /// Bind an approval interaction request to a step that is awaiting
    /// approval.
    pub fn bind_approval_interaction(
        &mut self,
        step_name: &str,
        interaction_request_id: String,
    ) -> PipelineAction {
        if let Some(StepState::AwaitingApproval {
            interaction_request_id: current_request_id,
        }) = self.step_states.get_mut(step_name)
        {
            if current_request_id.is_none() {
                *current_request_id = Some(interaction_request_id);
            }
        }
        PipelineAction::Waiting
    }

    /// Mark an approval gate as approved, transitioning the step to `Passed`
    /// without re-running it and dispatching any downstream steps.
    pub fn approve_gate(&mut self, step_name: &str) -> PipelineAction {
        if !matches!(
            self.step_states.get(step_name),
            Some(StepState::AwaitingApproval { .. })
        ) {
            return PipelineAction::Waiting;
        }

        self.step_states
            .insert(step_name.to_string(), StepState::Passed);
        if self.all_passed() {
            PipelineAction::Succeeded
        } else {
            self.find_dispatchable()
        }
    }

    /// Mark an approval gate as rejected, halting the pipeline.
    pub fn reject_gate(&mut self, step_name: &str, reason: String) -> PipelineAction {
        if !matches!(
            self.step_states.get(step_name),
            Some(StepState::AwaitingApproval { .. })
        ) {
            return PipelineAction::Waiting;
        }

        self.step_states.insert(
            step_name.to_string(),
            StepState::Rejected {
                summary: reason.clone(),
            },
        );
        PipelineAction::Failed {
            step: step_name.to_string(),
            reason,
        }
    }

    /// Handle a step that is blocked waiting for a human interaction response.
    pub fn step_blocked_on_human(
        &mut self,
        step_name: &str,
        interaction_request_id: String,
    ) -> PipelineAction {
        self.step_states.insert(
            step_name.to_string(),
            StepState::BlockedOnHuman {
                interaction_request_id: interaction_request_id.clone(),
            },
        );
        PipelineAction::BlockedOnHuman {
            step: step_name.to_string(),
            interaction_request_id,
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

    /// Step names in configured DAG order, excluding steps that never started.
    pub(crate) fn traversed_steps_in_order(&self) -> Vec<String> {
        self.dag
            .steps
            .iter()
            .filter_map(|step| match self.step_states.get(&step.name) {
                Some(StepState::Pending) | None => None,
                Some(_) => Some(step.name.clone()),
            })
            .collect()
    }

    /// Returns `true` when every step in the DAG is in the
    /// [`StepState::Passed`] state.
    fn all_passed(&self) -> bool {
        self.dag
            .steps
            .iter()
            .all(|s| self.step_states.get(&s.name) == Some(&StepState::Passed))
    }

    fn gate_check(&self, step_name: &str, approval_requested: bool) -> ApprovalGateCheck {
        let step_approval_mode = self
            .dag
            .steps
            .iter()
            .find(|step| step.name == step_name)
            .and_then(|step| step.approval.as_ref().map(|approval| approval.mode));

        match step_approval_mode {
            Some(crate::config::ensemble::StepApprovalMode::Always) => {
                ApprovalGateCheck::EligibleGating
            }
            Some(crate::config::ensemble::StepApprovalMode::WhenRequestedByAgent) => {
                if approval_requested {
                    ApprovalGateCheck::EligibleGating
                } else {
                    ApprovalGateCheck::NotRequested
                }
            }
            None => {
                if approval_requested {
                    ApprovalGateCheck::UnconfiguredButRequested
                } else {
                    ApprovalGateCheck::NotRequested
                }
            }
        }
    }

    fn approval_state_for(&self, step_name: &str) -> Option<String> {
        self.dag
            .steps
            .iter()
            .find(|step| step.name == step_name)
            .and_then(|step| step.approval.as_ref())
            .and_then(|approval| approval.state.clone())
    }

    pub fn output_context_for(&self, step_name: &str) -> Option<StepOutputTemplateContext> {
        let step = self.dag.steps.iter().find(|step| step.name == step_name)?;
        let steps = self
            .step_outputs
            .iter()
            .map(|(name, output)| (name.clone(), template_entry(name, output)))
            .collect();
        let dependency_outputs = step
            .depends
            .iter()
            .filter_map(|dep| {
                self.step_outputs
                    .get(dep)
                    .map(|output| template_entry(dep, output))
            })
            .collect();

        Some(StepOutputTemplateContext {
            steps,
            dependency_outputs,
        })
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

fn template_entry(step: &str, output: &StepOutput) -> StepOutputTemplateEntry {
    StepOutputTemplateEntry {
        step: step.to_string(),
        verdict: match &output.verdict {
            Verdict::Approve => "approve".to_string(),
            Verdict::Reject { .. } => "reject".to_string(),
        },
        summary: output.summary.clone(),
        output: output.output.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::{StepApprovalConfig, StepApprovalMode, StepConfig};
    use crate::pipeline::dag::build_dag;
    use crate::pipeline::verdict::StepOutput;
    use serde_json::json;

    fn make_step(name: &str, agent: &str, depends: &[&str]) -> StepConfig {
        let deps = if depends.is_empty() {
            None
        } else {
            Some(depends.iter().map(|s| s.to_string()).collect())
        };
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: deps,
            tracker_state: None,
            approval: None,
        }
    }

    fn make_step_with_state(
        name: &str,
        agent: &str,
        depends: &[&str],
        tracker_state: &str,
    ) -> StepConfig {
        let deps = if depends.is_empty() {
            None
        } else {
            Some(depends.iter().map(|s| s.to_string()).collect())
        };
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: deps,
            tracker_state: Some(tracker_state.to_string()),
            approval: None,
        }
    }

    fn make_step_with_approval(
        name: &str,
        agent: &str,
        depends: &[&str],
        mode: StepApprovalMode,
        state: Option<&str>,
    ) -> StepConfig {
        let deps = if depends.is_empty() {
            None
        } else {
            Some(depends.iter().map(|s| s.to_string()).collect())
        };
        StepConfig {
            name: name.to_string(),
            agent: agent.to_string(),
            depends: deps,
            tracker_state: None,
            approval: Some(StepApprovalConfig {
                mode,
                state: state.map(|value| value.to_string()),
            }),
        }
    }

    /// Build a `PipelineRun` from a slice of `StepConfig` entries.
    fn make_run(steps: &[StepConfig]) -> PipelineRun {
        let dag = build_dag(steps).unwrap();
        PipelineRun::new("issue-1".to_string(), 1, dag)
    }

    fn approve_output() -> StepOutput {
        StepOutput {
            verdict: Verdict::Approve,
            summary: None,
            output: None,
        }
    }

    fn reject_output(summary: &str) -> StepOutput {
        StepOutput {
            verdict: Verdict::Reject {
                summary: summary.to_string(),
            },
            summary: Some(summary.to_string()),
            output: None,
        }
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
        let action = run.step_completed("build", approve_output(), false);
        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "test"),
            "expected Dispatch([test]), got {action:?}"
        );

        run.mark_running("test", "session-2".to_string());

        // test completes with approve → all done.
        let action = run.step_completed("test", approve_output(), false);
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
        let action = run.step_completed("build", approve_output(), false);

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
        let _ = run.step_completed("review-a", approve_output(), false);
        // After review-a passes, review-b is still running → Waiting.
        let _action = run.step_completed("review-a", approve_output(), false);
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
        run2.step_completed("build", approve_output(), false);
        run2.mark_running("review-a", "s-ra".to_string());
        run2.mark_running("review-b", "s-rb".to_string());

        // review-a passes first; review-b is still Running → Waiting.
        let action = run2.step_completed("review-a", approve_output(), false);
        assert_eq!(
            action,
            PipelineAction::Waiting,
            "expected Waiting while review-b still running, got {action:?}"
        );

        // Now review-b also passes → Succeeded.
        let action = run2.step_completed("review-b", approve_output(), false);
        assert_eq!(action, PipelineAction::Succeeded);
    }

    #[test]
    fn approved_step_with_always_gate_waits_for_approval() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step_with_approval(
                "implement",
                "implementer",
                &["build"],
                StepApprovalMode::Always,
                Some("Ready for approval"),
            ),
        ];
        let mut run = make_run(&steps);

        run.mark_running("build", "session-build".to_string());
        let action = run.step_completed("build", approve_output(), false);
        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "implement"),
            "expected implement to dispatch after build, got {action:?}"
        );

        run.mark_running("implement", "session-implement".to_string());
        let action = run.step_completed("implement", approve_output(), false);
        assert!(
            matches!(
                &action,
                PipelineAction::AwaitingApproval {
                    step,
                    approval_state
                } if step == "implement" && approval_state.as_deref() == Some("Ready for approval")
            ),
            "expected AwaitingApproval for implement, got {action:?}"
        );
        assert_eq!(
            run.step_states["implement"],
            StepState::AwaitingApproval {
                interaction_request_id: None
            }
        );
    }

    #[test]
    fn approve_gate_dispatches_downstream_steps() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step_with_approval(
                "implement",
                "implementer",
                &["build"],
                StepApprovalMode::Always,
                Some("Approve implementation"),
            ),
            make_step("review", "reviewer", &["implement"]),
        ];
        let mut run = make_run(&steps);

        run.mark_running("build", "session-build".to_string());
        assert!(matches!(
            run.step_completed("build", approve_output(), false),
            PipelineAction::Dispatch(_)
        ));

        run.mark_running("implement", "session-implement".to_string());
        let action = run.step_completed("implement", approve_output(), false);
        assert!(matches!(action, PipelineAction::AwaitingApproval { .. }));

        let action = run.bind_approval_interaction("implement", "approval-123".to_string());
        assert_eq!(action, PipelineAction::Waiting);
        assert_eq!(
            run.step_states["implement"],
            StepState::AwaitingApproval {
                interaction_request_id: Some("approval-123".to_string())
            }
        );

        let action = run.approve_gate("implement");
        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "review"),
            "expected downstream review dispatch after approval, got {action:?}"
        );
        assert_eq!(run.step_states["implement"], StepState::Passed);
    }

    #[test]
    fn conditional_gate_only_triggers_when_worker_requested_it() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step_with_approval(
                "implement",
                "implementer",
                &["build"],
                StepApprovalMode::WhenRequestedByAgent,
                Some("Wait for request"),
            ),
        ];
        let mut run = make_run(&steps);

        run.mark_running("build", "session-build".to_string());
        assert!(matches!(
            run.step_completed("build", approve_output(), false),
            PipelineAction::Dispatch(_)
        ));

        run.mark_running("implement", "session-implement".to_string());
        let action = run.step_completed("implement", approve_output(), false);
        assert!(
            matches!(&action, PipelineAction::Succeeded),
            "expected approve without request to complete the pipeline, got {action:?}"
        );
        assert_eq!(run.step_states["implement"], StepState::Passed);

        let steps = vec![
            make_step("build", "builder", &[]),
            make_step_with_approval(
                "implement",
                "implementer",
                &["build"],
                StepApprovalMode::WhenRequestedByAgent,
                Some("Wait for request"),
            ),
        ];
        let mut run = make_run(&steps);
        run.mark_running("build", "session-build".to_string());
        let _ = run.step_completed("build", approve_output(), false);
        run.mark_running("implement", "session-implement".to_string());
        let action = run.step_completed("implement", approve_output(), true);
        assert!(
            matches!(
                &action,
                PipelineAction::AwaitingApproval {
                    step,
                    approval_state
                } if step == "implement" && approval_state.as_deref() == Some("Wait for request")
            ),
            "expected approval-requested step to gate, got {action:?}"
        );
    }

    #[test]
    fn approve_gate_marks_completed_step_passed_without_rerunning_it() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step_with_approval(
                "implement",
                "implementer",
                &["build"],
                StepApprovalMode::Always,
                Some("Ready to gate"),
            ),
            make_step("review", "reviewer", &["implement"]),
        ];
        let mut run = make_run(&steps);

        run.mark_running("build", "session-build".to_string());
        let _ = run.step_completed("build", approve_output(), false);
        run.mark_running("implement", "session-implement".to_string());
        let action = run.step_completed("implement", approve_output(), false);
        assert!(matches!(action, PipelineAction::AwaitingApproval { .. }));

        let action = run.bind_approval_interaction("implement", "approval-456".to_string());
        assert_eq!(action, PipelineAction::Waiting);
        assert_eq!(
            run.step_states["implement"],
            StepState::AwaitingApproval {
                interaction_request_id: Some("approval-456".to_string())
            }
        );

        let action = run.approve_gate("implement");
        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "review"),
            "expected review dispatch after gate approval, got {action:?}"
        );
        assert_eq!(run.step_states["implement"], StepState::Passed);
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
        run.step_completed("build", approve_output(), false);
        run.mark_running("review", "s-r".to_string());

        let action = run.step_completed("review", reject_output("code quality is too low"), false);

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
        let action = run.step_completed("build", approve_output(), false);
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
        assert!(!StepState::BlockedOnHuman {
            interaction_request_id: "interaction-1".to_string()
        }
        .is_terminal());
        assert!(!StepState::AwaitingApproval {
            interaction_request_id: None
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

    #[test]
    fn blocked_step_sets_blocked_state() {
        let steps = vec![make_step("review", "reviewer", &[])];
        let mut run = make_run(&steps);

        run.mark_running("review", "session-review".to_string());

        let _ = run.step_blocked_on_human("review", "interaction-123".to_string());

        assert_eq!(
            run.step_states["review"],
            StepState::BlockedOnHuman {
                interaction_request_id: "interaction-123".to_string()
            }
        );
    }

    #[test]
    fn reject_gate_rejects_and_halts_from_approval_state() {
        let steps = vec![make_step_with_approval(
            "review",
            "reviewer",
            &[],
            StepApprovalMode::Always,
            Some("Review gate"),
        )];
        let mut run = make_run(&steps);

        let action = run.step_completed("review", approve_output(), false);
        assert!(matches!(action, PipelineAction::AwaitingApproval { .. }));

        let action = run.bind_approval_interaction("review", "approval-789".to_string());
        assert_eq!(action, PipelineAction::Waiting);

        let action = run.reject_gate("review", "needs more work".to_string());
        assert_eq!(
            action,
            PipelineAction::Failed {
                step: "review".to_string(),
                reason: "needs more work".to_string()
            }
        );
        assert_eq!(
            run.step_states["review"],
            StepState::Rejected {
                summary: "needs more work".to_string()
            }
        );
    }

    #[test]
    fn bind_approval_interaction_ignores_non_approval_states() {
        let steps = vec![make_step("build", "builder", &[])];
        let mut run = make_run(&steps);

        let action = run.bind_approval_interaction("build", "approval-ignored".to_string());

        assert_eq!(action, PipelineAction::Waiting);
        assert_eq!(run.step_states["build"], StepState::Pending);
    }

    #[test]
    fn blocked_step_returns_blocked_pipeline_action() {
        let steps = vec![make_step("review", "reviewer", &[])];
        let mut run = make_run(&steps);

        run.mark_running("review", "session-review".to_string());

        let action = run.step_blocked_on_human("review", "interaction-123".to_string());

        assert_eq!(
            action,
            PipelineAction::BlockedOnHuman {
                step: "review".to_string(),
                interaction_request_id: "interaction-123".to_string()
            }
        );
    }

    #[test]
    fn blocked_step_is_not_terminal_success_or_failure() {
        let steps = vec![make_step("review", "reviewer", &[])];
        let mut run = make_run(&steps);

        run.mark_running("review", "session-review".to_string());

        let action = run.step_blocked_on_human("review", "interaction-123".to_string());

        assert_eq!(
            action,
            PipelineAction::BlockedOnHuman {
                step: "review".to_string(),
                interaction_request_id: "interaction-123".to_string()
            }
        );
        assert!(!run.step_states["review"].is_terminal());
        assert_ne!(run.step_states["review"], StepState::Passed);
        assert!(
            !matches!(
                action,
                PipelineAction::Succeeded | PipelineAction::Failed { .. }
            ),
            "blocked step should not produce terminal pipeline action: {action:?}"
        );
    }

    #[test]
    fn downstream_steps_are_not_dispatched_when_a_dependency_is_blocked() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &["build"]),
            make_step("deploy", "deployer", &["review"]),
        ];
        let mut run = make_run(&steps);

        run.mark_running("build", "session-build".to_string());
        let action = run.step_completed("build", approve_output(), false);
        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "review"),
            "expected Dispatch([review]), got {action:?}"
        );

        run.mark_running("review", "session-review".to_string());
        let action = run.step_blocked_on_human("review", "interaction-123".to_string());

        assert_eq!(
            action,
            PipelineAction::BlockedOnHuman {
                step: "review".to_string(),
                interaction_request_id: "interaction-123".to_string()
            }
        );
        assert_eq!(run.find_dispatchable(), PipelineAction::Waiting);
    }

    #[test]
    fn downstream_context_contains_direct_dependency_outputs() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review-a", "reviewer", &["build"]),
            make_step("review-b", "reviewer", &["build"]),
            make_step("synth", "synthesizer", &["review-a", "review-b"]),
        ];
        let mut run = make_run(&steps);

        run.step_completed(
            "build",
            StepOutput {
                verdict: Verdict::Approve,
                summary: Some("built".to_string()),
                output: Some(json!({"artifact":"branch"})),
            },
            false,
        );
        run.step_completed(
            "review-a",
            StepOutput {
                verdict: Verdict::Approve,
                summary: Some("a ok".to_string()),
                output: Some(json!({"risk":"low"})),
            },
            false,
        );
        run.step_completed(
            "review-b",
            StepOutput {
                verdict: Verdict::Approve,
                summary: Some("b ok".to_string()),
                output: Some(json!({"risk":"medium"})),
            },
            false,
        );

        let context = run.output_context_for("synth").unwrap();

        assert_eq!(context.dependency_outputs.len(), 2);
        assert_eq!(context.dependency_outputs[0].step, "review-a");
        assert_eq!(context.dependency_outputs[1].step, "review-b");
        assert_eq!(context.steps["review-a"].summary.as_deref(), Some("a ok"));
    }

    #[test]
    fn step_completed_fails_when_worker_requests_approval_but_step_has_no_approval_config() {
        let steps = vec![make_step("build", "builder", &[])];
        let mut run = make_run(&steps);

        run.mark_running("build", "session-build".to_string());
        let action = run.step_completed("build", approve_output(), true);

        assert!(
            matches!(
                &action,
                PipelineAction::Failed { step, reason }
                    if step == "build" && reason.contains("no approval configuration")
            ),
            "expected Failed for unconfigured approval request, got {action:?}"
        );
        assert!(matches!(
            &run.step_states["build"],
            StepState::Failed { error } if error.contains("no approval configuration")
        ));
    }
}
