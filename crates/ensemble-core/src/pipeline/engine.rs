use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::acceptance::AcceptanceAttempt;
use crate::config::ensemble::{OnFailure, StepKind};
use crate::pipeline::dag::{DagStep, StepDag};
use crate::pipeline::verdict::{StepOutput, StepResult};

/// The execution state of a single pipeline step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
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
    /// Step completed with a failed result.
    Failed { summary: String },
    /// Step failed due to an agent crash or runtime error.
    Errored { error: String },
}

impl StepState {
    /// Returns `true` if the step is in a terminal state (no further
    /// transitions are possible).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Passed | Self::Failed { .. } | Self::Errored { .. }
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
    /// The kind of the step (agent or synthesis).
    pub step_kind: StepKind,
    /// Optional tracker state to set while the step is running.
    pub tracker_state: Option<String>,
    /// Optional per-step turn timeout in milliseconds.
    pub timeout_ms: Option<u64>,
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
    /// A step failed or errored — pipeline halted.
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
    pub result: String,
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
    /// Durable acceptance evidence retained across whole-issue cycles.
    pub acceptance_attempts: Vec<AcceptanceAttempt>,
    /// Acceptance descriptors frozen from the configuration that created this run.
    pub resolved_acceptance_plan: Option<crate::acceptance::ResolvedAcceptancePlan>,
    /// The resolved, validated step DAG.
    dag: StepDag,
    /// Synthetic fixup steps generated for step-level retries.
    synthetic_fixup_steps: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PipelineRunSnapshot {
    pub issue_id: String,
    pub cycle: u32,
    pub step_states: HashMap<String, StepState>,
    pub step_outputs: HashMap<String, StepOutput>,
    #[serde(default)]
    pub acceptance_attempts: Vec<AcceptanceAttempt>,
    #[serde(default)]
    pub resolved_acceptance_plan: Option<crate::acceptance::ResolvedAcceptancePlan>,
    pub dag_steps: Vec<DagStep>,
    pub synthetic_fixup_steps: HashSet<String>,
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
            acceptance_attempts: Vec::new(),
            resolved_acceptance_plan: None,
            dag,
            synthetic_fixup_steps: HashSet::new(),
        }
    }

    pub fn to_snapshot(&self) -> PipelineRunSnapshot {
        PipelineRunSnapshot {
            issue_id: self.issue_id.clone(),
            cycle: self.cycle,
            step_states: self.step_states.clone(),
            step_outputs: self.step_outputs.clone(),
            acceptance_attempts: self.acceptance_attempts.clone(),
            resolved_acceptance_plan: self.resolved_acceptance_plan.clone(),
            dag_steps: self.dag.steps.clone(),
            synthetic_fixup_steps: self.synthetic_fixup_steps.clone(),
        }
    }

    pub fn from_snapshot(
        snapshot: PipelineRunSnapshot,
    ) -> Result<Self, crate::error::PipelineError> {
        validate_snapshot(&snapshot)?;
        Ok(Self {
            issue_id: snapshot.issue_id,
            cycle: snapshot.cycle,
            step_states: snapshot.step_states,
            step_outputs: snapshot.step_outputs,
            acceptance_attempts: snapshot.acceptance_attempts,
            resolved_acceptance_plan: snapshot.resolved_acceptance_plan,
            dag: StepDag {
                steps: snapshot.dag_steps,
            },
            synthetic_fixup_steps: snapshot.synthetic_fixup_steps,
        })
    }

    pub fn normalize_stale_running_steps(&mut self) {
        for state in self.step_states.values_mut() {
            if matches!(state, StepState::Running { .. }) {
                *state = StepState::Pending;
            }
        }
    }

    /// Compute the initial dispatch action — all root steps (no dependencies)
    /// are ready to run immediately.
    pub fn start(&self) -> PipelineAction {
        if self.all_passed() {
            return PipelineAction::Succeeded;
        }
        self.find_dispatchable()
    }

    /// Record that a step has been dispatched and is now running in the given
    /// session.
    pub fn mark_running(&mut self, step_name: &str, session_id: String) {
        self.step_states
            .insert(step_name.to_string(), StepState::Running { session_id });
    }

    /// Handle a completed step result.
    ///
    /// - [`StepResult::Succeeded`] → either transitions to
    ///   [`PipelineAction::AwaitingApproval`] for approval-gated steps, or
    ///   marks the step as [`StepState::Passed`] and checks whether all steps
    ///   are done or if new steps can be dispatched.
    /// - [`StepResult::Failed`] → marks the step as [`StepState::Failed`] and
    ///   returns [`PipelineAction::Failed`].
    pub fn step_completed(
        &mut self,
        step_name: &str,
        output: StepOutput,
        approval_requested: bool,
    ) -> PipelineAction {
        let result = output.result.clone();
        self.step_outputs.insert(step_name.to_string(), output);
        match result {
            StepResult::Succeeded => match self.gate_check(step_name, approval_requested) {
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
                        StepState::Errored {
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
            StepResult::Concern { .. } => {
                // Concern is a non-terminal-review signal for humans and
                // downstream steps. It intentionally continues like success
                // without applying approval gates or unconfigured approval
                // request errors.
                self.step_states
                    .insert(step_name.to_string(), StepState::Passed);
                if self.all_passed() {
                    PipelineAction::Succeeded
                } else {
                    self.find_dispatchable()
                }
            }
            StepResult::Failed { summary } => {
                self.step_states.insert(
                    step_name.to_string(),
                    StepState::Failed {
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

    /// Mark an approval gate as failed, halting the pipeline.
    pub fn reject_gate(&mut self, step_name: &str, reason: String) -> PipelineAction {
        if !matches!(
            self.step_states.get(step_name),
            Some(StepState::AwaitingApproval { .. })
        ) {
            return PipelineAction::Waiting;
        }

        self.step_states.insert(
            step_name.to_string(),
            StepState::Failed {
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
    /// Marks the step as [`StepState::Errored`] and returns
    /// [`PipelineAction::Failed`].
    pub fn step_failed(&mut self, step_name: &str, error: String) -> PipelineAction {
        self.step_states.insert(
            step_name.to_string(),
            StepState::Errored {
                error: error.clone(),
            },
        );
        PipelineAction::Failed {
            step: step_name.to_string(),
            reason: error,
        }
    }

    /// Return runtime DAG metadata for a step, including synthetic steps.
    pub fn step(&self, step_name: &str) -> Option<&DagStep> {
        self.dag.steps.iter().find(|step| step.name == step_name)
    }

    pub(crate) fn workflow_steps(&self) -> impl Iterator<Item = &DagStep> {
        self.dag
            .steps
            .iter()
            .filter(|step| !self.synthetic_fixup_steps.contains(&step.name))
    }

    /// Reset `step_name` and every step that transitively depends on it back
    /// to pending, clearing any stored outputs for those steps.
    pub fn retry_from_step(&mut self, step_name: &str) -> HashSet<String> {
        let reset_steps = self.dag.downstream_steps(step_name);
        for step in &reset_steps {
            self.step_states.insert(step.clone(), StepState::Pending);
            self.step_outputs.remove(step);
        }
        reset_steps
    }

    /// Reset from `step_name` and insert a synthetic fixup step immediately
    /// before it, rewiring the failed step to depend on the fixup.
    pub fn retry_from_step_with_fixup(
        &mut self,
        step_name: &str,
        fixup_agent: &str,
    ) -> HashSet<String> {
        let Some(step_index) = self
            .dag
            .steps
            .iter()
            .position(|step| step.name == step_name)
        else {
            return HashSet::new();
        };
        let current_deps = self.dag.steps[step_index].depends.clone();
        let original_deps =
            if current_deps.len() == 1 && self.synthetic_fixup_steps.contains(&current_deps[0]) {
                self.dag
                    .steps
                    .iter()
                    .find(|step| step.name == current_deps[0])
                    .map(|step| step.depends.clone())
                    .unwrap_or_default()
            } else {
                current_deps
            };
        let reset_steps = self.retry_from_step(step_name);
        let fixup_name = self.fixup_step_name_for(step_name);

        if !self.synthetic_fixup_steps.contains(&fixup_name) {
            if let Some(step_index) = self
                .dag
                .steps
                .iter()
                .position(|step| step.name == step_name)
            {
                self.dag.steps.insert(
                    step_index,
                    DagStep {
                        name: fixup_name.clone(),
                        agent: fixup_agent.to_string(),
                        kind: StepKind::Agent,
                        tracker_state: None,
                        timeout_ms: None,
                        approval: None,
                        on_failure: OnFailure::Halt,
                        fixup_agent: None,
                        depends: original_deps,
                    },
                );
                self.synthetic_fixup_steps.insert(fixup_name.clone());
            }
        }

        if let Some(step) = self
            .dag
            .steps
            .iter_mut()
            .find(|step| step.name == step_name)
        {
            step.depends = vec![fixup_name.clone()];
        }
        self.step_states
            .insert(fixup_name.clone(), StepState::Pending);
        self.step_outputs.remove(&fixup_name);

        reset_steps
    }

    fn fixup_step_name_for(&self, step_name: &str) -> String {
        let base_name = format!("fixup-{step_name}");
        if !self.dag.steps.iter().any(|step| step.name == base_name)
            || self.synthetic_fixup_steps.contains(&base_name)
        {
            return base_name;
        }

        for suffix in 1.. {
            let candidate = format!("{base_name}-{suffix}");
            if !self.dag.steps.iter().any(|step| step.name == candidate)
                || self.synthetic_fixup_steps.contains(&candidate)
            {
                return candidate;
            }
        }
        unreachable!("unbounded suffix search should always find a fixup step name")
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
                step_kind: s.kind,
                tracker_state: s.tracker_state.clone(),
                timeout_ms: s.timeout_ms,
            })
            .collect();

        if requests.is_empty() {
            PipelineAction::Waiting
        } else {
            PipelineAction::Dispatch(requests)
        }
    }
}

fn validate_snapshot(snapshot: &PipelineRunSnapshot) -> Result<(), crate::error::PipelineError> {
    if snapshot.dag_steps.is_empty() {
        return Err(crate::error::PipelineError::InvalidSnapshot {
            reason: "runtime dag has no steps".to_string(),
        });
    }

    let mut known_steps = HashSet::new();
    for step in &snapshot.dag_steps {
        if !known_steps.insert(step.name.as_str()) {
            return Err(crate::error::PipelineError::InvalidSnapshot {
                reason: format!("runtime dag contains duplicate step '{}'", step.name),
            });
        }
    }

    for step_name in snapshot.step_states.keys() {
        if !known_steps.contains(step_name.as_str()) {
            return Err(crate::error::PipelineError::InvalidSnapshot {
                reason: format!("step state references missing step '{step_name}'"),
            });
        }
    }

    for step_name in snapshot.step_outputs.keys() {
        if !known_steps.contains(step_name.as_str()) {
            return Err(crate::error::PipelineError::InvalidSnapshot {
                reason: format!("step output references missing step '{step_name}'"),
            });
        }
    }

    for step in &snapshot.dag_steps {
        if !snapshot.step_states.contains_key(&step.name) {
            return Err(crate::error::PipelineError::InvalidSnapshot {
                reason: format!("runtime dag step '{}' has no step state", step.name),
            });
        }
        for dependency in &step.depends {
            if !known_steps.contains(dependency.as_str()) {
                return Err(crate::error::PipelineError::InvalidSnapshot {
                    reason: format!(
                        "step '{}' depends on missing step '{}'",
                        step.name, dependency
                    ),
                });
            }
        }
    }

    validate_snapshot_acyclic(snapshot)?;

    Ok(())
}

fn validate_snapshot_acyclic(
    snapshot: &PipelineRunSnapshot,
) -> Result<(), crate::error::PipelineError> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum VisitState {
        Visiting,
        Visited,
    }

    fn visit<'a>(
        step_name: &'a str,
        steps_by_name: &HashMap<&'a str, &'a DagStep>,
        visit_states: &mut HashMap<&'a str, VisitState>,
    ) -> Result<(), crate::error::PipelineError> {
        match visit_states.get(step_name) {
            Some(VisitState::Visiting) => {
                return Err(crate::error::PipelineError::InvalidSnapshot {
                    reason: format!("runtime dag contains a cycle at step '{step_name}'"),
                });
            }
            Some(VisitState::Visited) => return Ok(()),
            None => {}
        }

        visit_states.insert(step_name, VisitState::Visiting);
        if let Some(step) = steps_by_name.get(step_name) {
            for dependency in &step.depends {
                visit(dependency, steps_by_name, visit_states)?;
            }
        }
        visit_states.insert(step_name, VisitState::Visited);
        Ok(())
    }

    let steps_by_name: HashMap<&str, &DagStep> = snapshot
        .dag_steps
        .iter()
        .map(|step| (step.name.as_str(), step))
        .collect();
    let mut visit_states = HashMap::new();
    for step in &snapshot.dag_steps {
        visit(step.name.as_str(), &steps_by_name, &mut visit_states)?;
    }
    Ok(())
}

fn template_entry(step: &str, output: &StepOutput) -> StepOutputTemplateEntry {
    StepOutputTemplateEntry {
        step: step.to_string(),
        result: match &output.result {
            StepResult::Succeeded => "succeeded".to_string(),
            StepResult::Concern { .. } => "concern".to_string(),
            StepResult::Failed { .. } => "failed".to_string(),
        },
        summary: output.summary.clone(),
        output: output.output.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ensemble::{
        OnFailure, StepApprovalConfig, StepApprovalMode, StepConfig, StepKind,
    };
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
            kind: StepKind::Agent,
            agent: agent.to_string(),
            depends: deps,
            tracker_state: None,
            timeout_ms: None,
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
        }
    }

    fn test_step(name: &str, agent: &str, depends: Option<Vec<String>>) -> StepConfig {
        StepConfig {
            name: name.to_string(),
            kind: StepKind::Agent,
            agent: agent.to_string(),
            depends,
            tracker_state: None,
            timeout_ms: None,
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
        }
    }

    #[test]
    fn pipeline_run_snapshot_round_trips_runtime_dag_and_outputs() {
        let steps = vec![
            test_step("build", "builder", Some(vec![])),
            test_step("review", "reviewer", Some(vec!["build".to_string()])),
        ];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let mut run = PipelineRun::new("issue-1".to_string(), 2, dag);
        run.mark_running("build", "session-build".to_string());
        run.step_completed(
            "build",
            crate::pipeline::verdict::StepOutput {
                result: crate::pipeline::verdict::StepResult::Succeeded,
                summary: Some("compiled".to_string()),
                output: Some(serde_json::json!({"binary": "ok"})),
            },
            false,
        );
        run.retry_from_step_with_fixup("review", "fixer");

        let snapshot = run.to_snapshot();
        let json = serde_json::to_string(&snapshot).unwrap();
        let decoded: PipelineRunSnapshot = serde_json::from_str(&json).unwrap();
        let restored = PipelineRun::from_snapshot(decoded).unwrap();

        assert_eq!(restored.issue_id, "issue-1");
        assert_eq!(restored.cycle, 2);
        assert_eq!(restored.step_states.get("build"), Some(&StepState::Passed));
        assert!(restored.step_outputs.contains_key("build"));
        assert!(restored.step("fixup-review").is_some());
        assert_eq!(
            restored.step("review").unwrap().depends,
            vec!["fixup-review".to_string()]
        );
    }

    #[test]
    fn pipeline_run_snapshot_defaults_missing_dag_step_timeout() {
        let steps = vec![test_step("build", "builder", Some(vec![]))];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let run = PipelineRun::new("issue-1".to_string(), 1, dag);

        let mut value = serde_json::to_value(run.to_snapshot()).unwrap();
        let dag_steps = value["dag_steps"].as_array_mut().unwrap();
        dag_steps[0].as_object_mut().unwrap().remove("timeout_ms");

        let decoded: PipelineRunSnapshot = serde_json::from_value(value).unwrap();
        let restored = PipelineRun::from_snapshot(decoded).unwrap();

        assert_eq!(restored.step("build").unwrap().timeout_ms, None);
    }

    #[test]
    fn pipeline_run_snapshot_normalizes_stale_running_steps_to_pending() {
        let steps = vec![test_step("build", "builder", Some(vec![]))];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let mut run = PipelineRun::new("issue-1".to_string(), 1, dag);
        run.mark_running("build", "session-build".to_string());

        let mut restored = PipelineRun::from_snapshot(run.to_snapshot()).unwrap();
        restored.normalize_stale_running_steps();

        assert_eq!(restored.step_states.get("build"), Some(&StepState::Pending));
    }

    #[test]
    fn pipeline_run_snapshot_rejects_step_state_outside_runtime_dag() {
        let steps = vec![test_step("build", "builder", Some(vec![]))];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let run = PipelineRun::new("issue-1".to_string(), 1, dag);
        let mut snapshot = run.to_snapshot();
        snapshot
            .step_states
            .insert("missing".to_string(), StepState::Passed);

        let err = PipelineRun::from_snapshot(snapshot).unwrap_err();
        assert!(err.to_string().contains("missing"));
    }

    #[test]
    fn pipeline_run_snapshot_rejects_step_output_outside_runtime_dag() {
        let steps = vec![test_step("build", "builder", Some(vec![]))];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let run = PipelineRun::new("issue-1".to_string(), 1, dag);
        let mut snapshot = run.to_snapshot();
        snapshot.step_outputs.insert(
            "missing".to_string(),
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: None,
            },
        );

        let err = PipelineRun::from_snapshot(snapshot).unwrap_err();
        assert!(err.to_string().contains("missing"));
    }

    #[test]
    fn pipeline_run_snapshot_rejects_missing_dependency() {
        let steps = vec![test_step("build", "builder", Some(vec![]))];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let run = PipelineRun::new("issue-1".to_string(), 1, dag);
        let mut snapshot = run.to_snapshot();
        snapshot.dag_steps[0].depends = vec!["missing".to_string()];

        let err = PipelineRun::from_snapshot(snapshot).unwrap_err();
        assert!(err.to_string().contains("missing"));
    }

    #[test]
    fn pipeline_run_snapshot_rejects_dag_step_without_state() {
        let steps = vec![test_step("build", "builder", Some(vec![]))];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let run = PipelineRun::new("issue-1".to_string(), 1, dag);
        let mut snapshot = run.to_snapshot();
        snapshot.step_states.remove("build");

        let err = PipelineRun::from_snapshot(snapshot).unwrap_err();
        assert!(err.to_string().contains("no step state"));
    }

    #[test]
    fn pipeline_run_snapshot_rejects_duplicate_dag_steps() {
        let steps = vec![test_step("build", "builder", Some(vec![]))];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let run = PipelineRun::new("issue-1".to_string(), 1, dag);
        let mut snapshot = run.to_snapshot();
        snapshot.dag_steps.push(snapshot.dag_steps[0].clone());

        let err = PipelineRun::from_snapshot(snapshot).unwrap_err();
        assert!(err.to_string().contains("duplicate"));
    }

    #[test]
    fn pipeline_run_snapshot_rejects_cycles() {
        let steps = vec![
            test_step("build", "builder", Some(vec![])),
            test_step("review", "reviewer", Some(vec!["build".to_string()])),
        ];
        let dag = crate::pipeline::dag::build_dag(&steps).unwrap();
        let run = PipelineRun::new("issue-1".to_string(), 1, dag);
        let mut snapshot = run.to_snapshot();
        snapshot
            .dag_steps
            .iter_mut()
            .find(|step| step.name == "build")
            .unwrap()
            .depends = vec!["review".to_string()];

        let err = PipelineRun::from_snapshot(snapshot).unwrap_err();
        assert!(err.to_string().contains("cycle"));
    }

    #[test]
    fn dispatch_request_carries_step_timeout_ms() {
        let steps = vec![StepConfig {
            name: "build".to_string(),
            kind: StepKind::Agent,
            agent: "builder".to_string(),
            depends: Some(vec![]),
            tracker_state: None,
            timeout_ms: Some(90_000),
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
        }];
        let run = make_run(&steps);

        let PipelineAction::Dispatch(requests) = run.start() else {
            panic!("expected dispatch action");
        };

        assert_eq!(requests[0].timeout_ms, Some(90_000));
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
            kind: StepKind::Agent,
            agent: agent.to_string(),
            depends: deps,
            tracker_state: Some(tracker_state.to_string()),
            timeout_ms: None,
            approval: None,
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
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
            kind: StepKind::Agent,
            agent: agent.to_string(),
            depends: deps,
            tracker_state: None,
            timeout_ms: None,
            approval: Some(StepApprovalConfig {
                mode,
                state: state.map(|value| value.to_string()),
            }),
            on_failure: OnFailure::RetryIssue,
            fixup_agent: None,
        }
    }

    /// Build a `PipelineRun` from a slice of `StepConfig` entries.
    fn make_run(steps: &[StepConfig]) -> PipelineRun {
        let dag = build_dag(steps).unwrap();
        PipelineRun::new("issue-1".to_string(), 1, dag)
    }

    fn approve_output() -> StepOutput {
        StepOutput {
            result: StepResult::Succeeded,
            summary: None,
            output: None,
        }
    }

    fn approve_output_with_summary(summary: &str) -> StepOutput {
        StepOutput {
            result: StepResult::Succeeded,
            summary: Some(summary.to_string()),
            output: None,
        }
    }

    fn failed_output(summary: &str) -> StepOutput {
        StepOutput {
            result: StepResult::Failed {
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

    #[test]
    fn failed_result_halts_pipeline() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &[]),
        ];
        let mut run = make_run(&steps);

        run.mark_running("build", "s-b".to_string());
        run.step_completed("build", approve_output(), false);
        run.mark_running("review", "s-r".to_string());

        let action = run.step_completed("review", failed_output("code quality is too low"), false);

        assert!(
            matches!(
                &action,
                PipelineAction::Failed { step, reason }
                    if step == "review" && reason == "code quality is too low"
            ),
            "expected Failed for failed review result, got {action:?}"
        );

        // Step state should reflect failed result.
        assert!(matches!(
            &run.step_states["review"],
            StepState::Failed { summary } if summary == "code quality is too low"
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
            StepState::Errored { error } if error == "agent crashed with exit code 1"
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
        assert!(StepState::Failed {
            summary: "nope".to_string()
        }
        .is_terminal());
        assert!(StepState::Errored {
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
    fn reject_gate_marks_step_failed_and_halts_from_approval_state() {
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
            StepState::Failed {
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
                result: StepResult::Succeeded,
                summary: Some("built".to_string()),
                output: Some(json!({"artifact":"branch"})),
            },
            false,
        );
        run.step_completed(
            "review-a",
            StepOutput {
                result: StepResult::Succeeded,
                summary: Some("a ok".to_string()),
                output: Some(json!({"risk":"low"})),
            },
            false,
        );
        run.step_completed(
            "review-b",
            StepOutput {
                result: StepResult::Succeeded,
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
    fn concern_with_unconfigured_approval_request_continues_and_enters_context() {
        let steps = vec![
            make_step("review", "reviewer", &[]),
            make_step("synth", "synthesizer", &["review"]),
        ];
        let mut run = make_run(&steps);

        run.mark_running("review", "session-review".to_string());
        let action = run.step_completed(
            "review",
            StepOutput {
                result: StepResult::Concern {
                    summary: "minor issue found".to_string(),
                },
                summary: Some("minor issue found".to_string()),
                output: Some(json!({"risk":"medium"})),
            },
            true,
        );

        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "synth"),
            "expected concern to continue and dispatch synth, got {action:?}"
        );
        assert_eq!(run.step_states["review"], StepState::Passed);

        let context = run.output_context_for("synth").unwrap();
        assert_eq!(context.dependency_outputs.len(), 1);
        assert_eq!(context.dependency_outputs[0].step, "review");
        assert_eq!(context.dependency_outputs[0].result, "concern");
        assert_eq!(
            context.dependency_outputs[0].summary.as_deref(),
            Some("minor issue found")
        );
        assert_eq!(context.steps["review"].result, "concern");
    }

    #[test]
    fn concern_result_on_always_approval_step_bypasses_gate_and_dispatches_downstream() {
        let steps = vec![
            make_step_with_approval(
                "review",
                "reviewer",
                &[],
                StepApprovalMode::Always,
                Some("Review gate"),
            ),
            make_step("synth", "synthesizer", &["review"]),
        ];
        let mut run = make_run(&steps);

        run.mark_running("review", "session-review".to_string());
        let action = run.step_completed(
            "review",
            StepOutput {
                result: StepResult::Concern {
                    summary: "minor issue found".to_string(),
                },
                summary: Some("minor issue found".to_string()),
                output: None,
            },
            false,
        );

        assert!(
            matches!(&action, PipelineAction::Dispatch(reqs) if reqs.len() == 1 && reqs[0].step_name == "synth"),
            "expected concern on approval-gated step to dispatch synth without gating, got {action:?}"
        );
        assert_eq!(run.step_states["review"], StepState::Passed);
        assert!(!matches!(
            run.step_states["review"],
            StepState::AwaitingApproval { .. }
        ));
    }

    #[test]
    fn concern_result_on_terminal_always_approval_step_bypasses_gate_and_succeeds() {
        let steps = vec![make_step_with_approval(
            "review",
            "reviewer",
            &[],
            StepApprovalMode::Always,
            Some("Review gate"),
        )];
        let mut run = make_run(&steps);

        run.mark_running("review", "session-review".to_string());
        let action = run.step_completed(
            "review",
            StepOutput {
                result: StepResult::Concern {
                    summary: "minor issue found".to_string(),
                },
                summary: Some("minor issue found".to_string()),
                output: None,
            },
            false,
        );

        assert_eq!(action, PipelineAction::Succeeded);
        assert_eq!(run.step_states["review"], StepState::Passed);
    }

    #[test]
    fn dispatch_request_carries_synthesis_kind() {
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
            },
        ];
        let mut run = make_run(&steps);

        assert!(matches!(run.start(), PipelineAction::Dispatch(_)));
        let action = run.step_completed("review-a", approve_output(), false);

        match action {
            PipelineAction::Dispatch(requests) => {
                assert_eq!(requests.len(), 1);
                assert_eq!(requests[0].step_name, "synthesize");
                assert_eq!(requests[0].step_kind, StepKind::Synthesis);
            }
            other => panic!("expected synthesis dispatch, got {other:?}"),
        }
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
            StepState::Errored { error } if error.contains("no approval configuration")
        ));
    }

    #[test]
    fn retry_from_mid_dag_resets_failed_step_and_downstream_only() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("test", "tester", &["build"]),
            make_step("docs", "writer", &["build"]),
            make_step("deploy", "deployer", &["test"]),
        ];
        let mut run = make_run(&steps);

        run.step_completed("build", approve_output(), false);
        run.step_completed("docs", approve_output(), false);
        run.step_completed("deploy", approve_output(), false);
        run.step_completed("test", failed_output("tests failed"), false);

        let reset = run.retry_from_step("test");

        assert_eq!(
            reset,
            HashSet::from(["test".to_string(), "deploy".to_string()])
        );
        assert_eq!(run.step_states["build"], StepState::Passed);
        assert_eq!(run.step_states["docs"], StepState::Passed);
        assert_eq!(run.step_states["test"], StepState::Pending);
        assert_eq!(run.step_states["deploy"], StepState::Pending);
        assert!(run.step_outputs.contains_key("build"));
        assert!(run.step_outputs.contains_key("docs"));
        assert!(!run.step_outputs.contains_key("test"));
        assert!(!run.step_outputs.contains_key("deploy"));
    }

    #[test]
    fn retry_from_leaf_resets_only_leaf() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("test", "tester", &["build"]),
            make_step("deploy", "deployer", &["test"]),
        ];
        let mut run = make_run(&steps);

        run.step_completed("build", approve_output(), false);
        run.step_completed("test", approve_output(), false);
        run.step_completed("deploy", failed_output("deploy failed"), false);

        let reset = run.retry_from_step("deploy");

        assert_eq!(reset, HashSet::from(["deploy".to_string()]));
        assert_eq!(run.step_states["build"], StepState::Passed);
        assert_eq!(run.step_states["test"], StepState::Passed);
        assert_eq!(run.step_states["deploy"], StepState::Pending);
        assert!(run.step_outputs.contains_key("build"));
        assert!(run.step_outputs.contains_key("test"));
        assert!(!run.step_outputs.contains_key("deploy"));
    }

    #[test]
    fn retry_from_root_resets_all_downstream_steps() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("test", "tester", &["build"]),
            make_step("docs", "writer", &["build"]),
            make_step("deploy", "deployer", &["test", "docs"]),
        ];
        let mut run = make_run(&steps);

        run.step_completed("build", approve_output(), false);
        run.step_completed("test", approve_output(), false);
        run.step_completed("docs", approve_output(), false);
        run.step_completed("deploy", approve_output(), false);

        let reset = run.retry_from_step("build");

        assert_eq!(
            reset,
            HashSet::from([
                "build".to_string(),
                "test".to_string(),
                "docs".to_string(),
                "deploy".to_string()
            ])
        );
        assert!(reset
            .iter()
            .all(|step| run.step_states[step] == StepState::Pending));
        assert!(reset
            .iter()
            .all(|step| !run.step_outputs.contains_key(step)));
    }

    #[test]
    fn retry_from_step_with_fixup_injects_fixup_before_failed_step() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &["build"]),
            make_step("deploy", "deployer", &["review"]),
        ];
        let mut run = make_run(&steps);

        run.step_completed("build", approve_output(), false);
        run.step_completed("review", failed_output("needs fixes"), false);

        let reset = run.retry_from_step_with_fixup("review", "fixer");

        assert_eq!(
            reset,
            HashSet::from(["review".to_string(), "deploy".to_string()])
        );
        let fixup = run
            .dag
            .steps
            .iter()
            .find(|step| step.name == "fixup-review")
            .unwrap();
        assert_eq!(fixup.agent, "fixer");
        assert_eq!(fixup.kind, StepKind::Agent);
        assert_eq!(fixup.tracker_state, None);
        assert_eq!(fixup.approval, None);
        assert_eq!(fixup.depends, vec!["build".to_string()]);

        let review = run
            .dag
            .steps
            .iter()
            .find(|step| step.name == "review")
            .unwrap();
        assert_eq!(review.depends, vec!["fixup-review".to_string()]);
        assert_eq!(run.step_states["fixup-review"], StepState::Pending);
        assert_eq!(run.step_states["review"], StepState::Pending);
    }

    #[test]
    fn repeated_fixup_retry_does_not_duplicate_fixup_step() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &["build"]),
        ];
        let mut run = make_run(&steps);

        run.retry_from_step_with_fixup("review", "fixer");
        run.retry_from_step_with_fixup("review", "fixer");

        let fixup_count = run
            .dag
            .steps
            .iter()
            .filter(|step| step.name == "fixup-review")
            .count();
        assert_eq!(fixup_count, 1);
        let review = run
            .dag
            .steps
            .iter()
            .find(|step| step.name == "review")
            .unwrap();
        assert_eq!(review.depends, vec!["fixup-review".to_string()]);
    }

    #[test]
    fn repeated_fixup_retry_clears_stale_fixup_output() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &["build"]),
        ];
        let mut run = make_run(&steps);

        run.retry_from_step_with_fixup("review", "fixer");
        run.step_completed(
            "fixup-review",
            approve_output_with_summary("old fixup output"),
            false,
        );

        run.retry_from_step_with_fixup("review", "fixer");

        assert_eq!(run.step_states["fixup-review"], StepState::Pending);
        assert!(!run.step_outputs.contains_key("fixup-review"));
        let context = run.output_context_for("review").unwrap();
        assert!(context.dependency_outputs.is_empty());
    }

    #[test]
    fn configured_fixup_name_collision_uses_unique_synthetic_fixup_name() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("fixup-review", "configured-fixer", &["build"]),
            make_step("review", "reviewer", &["build"]),
        ];
        let mut run = make_run(&steps);

        run.retry_from_step_with_fixup("review", "synthetic-fixer");

        let configured_fixup = run
            .dag
            .steps
            .iter()
            .find(|step| step.name == "fixup-review")
            .unwrap();
        assert_eq!(configured_fixup.agent, "configured-fixer");
        assert_eq!(configured_fixup.depends, vec!["build".to_string()]);

        let synthetic_fixup = run
            .dag
            .steps
            .iter()
            .find(|step| step.name == "fixup-review-1")
            .unwrap();
        assert_eq!(synthetic_fixup.agent, "synthetic-fixer");
        assert_eq!(synthetic_fixup.depends, vec!["build".to_string()]);

        let review = run
            .dag
            .steps
            .iter()
            .find(|step| step.name == "review")
            .unwrap();
        assert_eq!(review.depends, vec!["fixup-review-1".to_string()]);
    }

    #[test]
    fn retry_from_step_with_fixup_for_unknown_step_is_no_op() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &["build"]),
        ];
        let mut run = make_run(&steps);
        let original_steps = run.dag.steps.clone();
        let original_states = run.step_states.clone();

        let reset = run.retry_from_step_with_fixup("unknown", "fixer");

        assert!(reset.is_empty());
        assert_eq!(run.dag.steps, original_steps);
        assert_eq!(run.step_states, original_states);
        assert!(!run.step_states.contains_key("fixup-unknown"));
    }

    #[test]
    fn snapshot_round_trip_preserves_acceptance_attempts_and_legacy_defaults_empty() {
        let mut run = make_run(&[make_step("build", "builder", &[])]);
        run.resolved_acceptance_plan = Some(crate::acceptance::ResolvedAcceptancePlan {
            config_digest: "sha256:test".into(),
            commands: vec!["test".into()],
            required_files: Vec::new(),
            required_handoff_sections: Vec::new(),
            required_pull_requests: Vec::new(),
        });
        run.acceptance_attempts = vec![crate::acceptance::AcceptanceAttempt {
            cycle: 1,
            results: vec![crate::acceptance::AcceptanceResult::command(
                "test".to_string(),
                crate::acceptance::AcceptanceStatus::Passed,
                "passed".to_string(),
                Some(0),
                crate::acceptance::AcceptanceOutput {
                    tail: "ok".to_string(),
                    total_bytes: 2,
                    truncated: false,
                },
                crate::acceptance::AcceptanceOutput {
                    tail: String::new(),
                    total_bytes: 0,
                    truncated: false,
                },
            )],
        }];

        let restored = PipelineRun::from_snapshot(run.to_snapshot()).unwrap();
        assert_eq!(restored.acceptance_attempts, run.acceptance_attempts);
        assert_eq!(
            restored.resolved_acceptance_plan,
            run.resolved_acceptance_plan
        );

        let mut legacy = serde_json::to_value(run.to_snapshot()).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("acceptance_attempts");
        legacy
            .as_object_mut()
            .unwrap()
            .remove("resolved_acceptance_plan");
        let legacy: PipelineRunSnapshot = serde_json::from_value(legacy).unwrap();
        assert!(legacy.acceptance_attempts.is_empty());
        assert!(legacy.resolved_acceptance_plan.is_none());
    }
}
