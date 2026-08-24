use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::acceptance::AcceptanceAttempt;
use crate::artifact::{ArtifactAccessEvidence, ArtifactIntegrityViolation, ArtifactSnapshot};
use crate::config::ensemble::{
    AffectedPathSource, ArtifactAccess, ArtifactSnapshotConfig, OnFailure, ResolvedOutputSchema,
    RouteConfig, StepAuthorizationConfig, StepKind,
};
use crate::orchestrator::resources::SchedulerReservation;
use crate::pipeline::assessment::{
    evaluate_gate, GateEvidence, GateHumanDecision, GateHumanResolution, GateOutcome,
};
use crate::pipeline::dag::{DagStep, StepDag};
use crate::pipeline::verdict::{StepOutput, StepResult};
use crate::tracker::{model::TrackerEvent, OwnershipLease};

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
    /// Step was intentionally excluded by one or more completed route decisions.
    Skipped {
        provenance: Vec<RouteSkipProvenance>,
    },
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
            Self::Passed | Self::Skipped { .. } | Self::Failed { .. } | Self::Errored { .. }
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

/// Durable evidence that a route selected a case from one validated producer output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RouteDecisionEvidence {
    pub source_step: String,
    pub pointer: String,
    pub selected_case: String,
    pub source_output_digest: String,
}

/// Why a step did not run. Nested routes retain every causal selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RouteSkipProvenance {
    pub route_step: String,
    pub source_step: String,
    pub selected_case: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_snapshot: Option<ArtifactSnapshot>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StepOutputTemplateContext {
    pub steps: HashMap<String, StepOutputTemplateEntry>,
    pub dependency_outputs: Vec<StepOutputTemplateEntry>,
    #[serde(skip_serializing)]
    pub output_schema: Option<ResolvedOutputSchema>,
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
    /// Captured producer identities, keyed by producer step.
    pub artifact_snapshots: HashMap<String, ArtifactSnapshot>,
    /// Content-free immutable Artifact evidence retained for restart recovery.
    pub artifact_integrity_violations: Vec<ArtifactIntegrityViolation>,
    pub artifact_access_evidence: Vec<ArtifactAccessEvidence>,
    /// Selected immutable tracker event and exact Artifact binding for protected steps.
    pub authorization_evidence: HashMap<String, AuthorizationEvidence>,
    /// Durable intent and acknowledgement for automatic tracker handoffs.
    automatic_transitions: HashMap<String, AutomaticTransitionState>,
    /// Deterministic assessment and adjudication evidence retained for each gate.
    pub gate_evidence: HashMap<String, GateEvidence>,
    /// Frozen selections, keyed by route step, used for recovery and downstream retries.
    pub route_decisions: HashMap<String, RouteDecisionEvidence>,
    /// Immutable consumers whose launch was durably committed. This authorizes
    /// launch; it does not claim that the child processed any instructions.
    launched_immutable_consumers: HashSet<String>,
    /// Durable acceptance evidence retained across whole-issue cycles.
    pub acceptance_attempts: Vec<AcceptanceAttempt>,
    /// Acceptance descriptors frozen from the configuration that created this run.
    pub resolved_acceptance_plan: Option<crate::acceptance::ResolvedAcceptancePlan>,
    /// The resolved, validated step DAG.
    dag: StepDag,
    /// Synthetic fixup steps generated for step-level retries.
    synthetic_fixup_steps: HashSet<String>,
    /// Opaque adapter ownership captured before any agent work starts.
    ownership_lease: Option<OwnershipLease>,
    /// Opaque configured workspace branch, including policies that do not claim remotely.
    workspace_branch_name: Option<String>,
    /// Configured workflow identity frozen before ownership is journaled.
    selected_workflow: Option<SelectedWorkflowSnapshot>,
    /// Concrete scheduler leases captured with running dispatch transitions, by step.
    active_scheduler_reservations: HashMap<String, SchedulerReservation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectedWorkflowSnapshot {
    pub rule: String,
    pub pipeline: String,
    pub lane: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PipelineRunSnapshot {
    pub issue_id: String,
    pub cycle: u32,
    pub step_states: HashMap<String, StepState>,
    pub step_outputs: HashMap<String, StepOutput>,
    #[serde(default)]
    pub artifact_snapshots: HashMap<String, ArtifactSnapshot>,
    #[serde(default)]
    pub authorization_evidence: HashMap<String, AuthorizationEvidence>,
    #[serde(default)]
    pub automatic_transitions: HashMap<String, AutomaticTransitionState>,
    #[serde(flatten)]
    pub artifact_integrity_evidence: Box<ArtifactIntegrityEvidence>,
    /// Consumers whose launches were durably committed before a crash.
    #[serde(default)]
    pub launched_immutable_consumers: HashSet<String>,
    #[serde(default)]
    pub gate_evidence: Box<HashMap<String, GateEvidence>>,
    #[serde(default)]
    pub route_decisions: HashMap<String, RouteDecisionEvidence>,
    #[serde(default)]
    pub acceptance_attempts: Vec<AcceptanceAttempt>,
    #[serde(default)]
    pub resolved_acceptance_plan: Option<crate::acceptance::ResolvedAcceptancePlan>,
    pub dag_steps: Vec<DagStep>,
    pub synthetic_fixup_steps: HashSet<String>,
    #[serde(default)]
    pub ownership_lease: Option<OwnershipLease>,
    #[serde(default)]
    pub workspace_branch_name: Option<String>,
    #[serde(default)]
    pub selected_workflow: Option<SelectedWorkflowSnapshot>,
    #[serde(default)]
    pub active_scheduler_reservations: HashMap<String, SchedulerReservation>,
}

/// Durable evidence that one protected step was authorized against one exact
/// Artifact snapshot. The event remains adapter-normalized and opaque.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationEvidence {
    pub event: TrackerEvent,
    pub artifact_identity: String,
    pub artifact_output_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AutomaticTransitionState {
    Pending {
        target_state: String,
        expected_state: String,
    },
    Applied {
        target_state: String,
    },
}

/// Heap-backed durable evidence so empty immutable Artifact support does not enlarge every
/// journal snapshot carried through ordinary acceptance and terminal lifecycle futures.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactIntegrityEvidence {
    #[serde(default)]
    pub artifact_integrity_violations: Vec<ArtifactIntegrityViolation>,
    #[serde(default)]
    pub artifact_access_evidence: Vec<ArtifactAccessEvidence>,
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
            artifact_snapshots: HashMap::new(),
            artifact_integrity_violations: Vec::new(),
            artifact_access_evidence: Vec::new(),
            authorization_evidence: HashMap::new(),
            automatic_transitions: HashMap::new(),
            gate_evidence: HashMap::new(),
            route_decisions: HashMap::new(),
            launched_immutable_consumers: HashSet::new(),
            acceptance_attempts: Vec::new(),
            resolved_acceptance_plan: None,
            dag,
            synthetic_fixup_steps: HashSet::new(),
            ownership_lease: None,
            workspace_branch_name: None,
            selected_workflow: None,
            active_scheduler_reservations: HashMap::new(),
        }
    }

    pub fn to_snapshot(&self) -> PipelineRunSnapshot {
        PipelineRunSnapshot {
            issue_id: self.issue_id.clone(),
            cycle: self.cycle,
            step_states: self.step_states.clone(),
            step_outputs: self.step_outputs.clone(),
            artifact_snapshots: self.artifact_snapshots.clone(),
            authorization_evidence: self.authorization_evidence.clone(),
            automatic_transitions: self.automatic_transitions.clone(),
            artifact_integrity_evidence: Box::new(ArtifactIntegrityEvidence {
                artifact_integrity_violations: self.artifact_integrity_violations.clone(),
                artifact_access_evidence: self.artifact_access_evidence.clone(),
            }),
            launched_immutable_consumers: self.launched_immutable_consumers.clone(),
            gate_evidence: Box::new(self.gate_evidence.clone()),
            route_decisions: self.route_decisions.clone(),
            acceptance_attempts: self.acceptance_attempts.clone(),
            resolved_acceptance_plan: self.resolved_acceptance_plan.clone(),
            dag_steps: self.dag.steps.clone(),
            synthetic_fixup_steps: self.synthetic_fixup_steps.clone(),
            ownership_lease: self.ownership_lease.clone(),
            workspace_branch_name: self.workspace_branch_name.clone(),
            selected_workflow: self.selected_workflow.clone(),
            active_scheduler_reservations: self.active_scheduler_reservations.clone(),
        }
    }

    pub(crate) fn scheduler_requirements_for(
        &self,
        step_name: &str,
    ) -> Option<(
        std::collections::BTreeMap<String, u32>,
        Option<AffectedPathSource>,
    )> {
        self.dag
            .steps
            .iter()
            .find(|step| step.name == step_name)
            .map(|step| (step.resource_requests.clone(), step.affected_paths.clone()))
    }

    pub(crate) fn set_active_scheduler_reservation(
        &mut self,
        step_name: &str,
        reservation: SchedulerReservation,
    ) {
        self.active_scheduler_reservations
            .insert(step_name.to_string(), reservation);
    }

    pub(crate) fn clear_active_scheduler_reservation(&mut self, step_name: &str) {
        self.active_scheduler_reservations.remove(step_name);
    }

    pub(crate) fn artifact_snapshot_selection_for(
        &self,
        step_name: &str,
    ) -> Option<&ArtifactSnapshotConfig> {
        self.dag
            .steps
            .iter()
            .find(|step| step.name == step_name)
            .and_then(|step| step.artifact_snapshot.as_ref())
    }

    pub(crate) fn artifact_inputs_for(
        &self,
        step_name: &str,
    ) -> Option<(&[String], ArtifactAccess)> {
        self.dag
            .steps
            .iter()
            .find(|step| step.name == step_name)
            .map(|step| (step.artifact_inputs.as_slice(), step.artifact_access))
    }

    pub(crate) fn authorization_for(&self, step_name: &str) -> Option<&StepAuthorizationConfig> {
        self.dag
            .steps
            .iter()
            .find(|step| step.name == step_name)
            .and_then(|step| step.authorization.as_ref())
    }

    /// Choose a matching event deterministically and bind it to the configured
    /// upstream Artifact. Missing publication time is legacy evidence and does
    /// not satisfy an ordering requirement.
    pub(crate) fn select_authorization_evidence(
        &self,
        step_name: &str,
        events: &[TrackerEvent],
    ) -> Option<AuthorizationEvidence> {
        let authorization = self.authorization_for(step_name)?;
        let artifact = self.artifact_snapshots.get(&authorization.artifact_step)?;
        let mut identities = HashMap::new();
        for event in events {
            if let Some(previous) = identities.insert(&event.event_id, event) {
                if previous != event {
                    return None;
                }
            }
        }
        let mut matching = events
            .iter()
            .filter(|event| {
                event.item_id == self.issue_id
                    && event.field_id == authorization.event.field
                    && event.value == authorization.event.value
                    && authorization
                        .event
                        .actors
                        .iter()
                        .any(|actor| actor == &event.actor_id)
                    && (!authorization.after_artifact
                        || artifact
                            .captured_at
                            .is_some_and(|captured_at| event.occurred_at > captured_at))
            })
            .collect::<Vec<_>>();
        matching.sort_by(|left, right| {
            left.occurred_at
                .cmp(&right.occurred_at)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        matching.last().map(|event| AuthorizationEvidence {
            event: (*event).clone(),
            artifact_identity: artifact.identity.clone(),
            artifact_output_digest: artifact.output_digest.clone(),
        })
    }

    pub(crate) fn authorization_evidence_is_current(
        &self,
        step_name: &str,
        events: &[TrackerEvent],
    ) -> bool {
        self.authorization_evidence.get(step_name)
            == self
                .select_authorization_evidence(step_name, events)
                .as_ref()
    }

    pub(crate) fn record_authorization_evidence(
        &mut self,
        step_name: &str,
        evidence: AuthorizationEvidence,
    ) {
        self.authorization_evidence
            .insert(step_name.to_string(), evidence);
    }

    pub(crate) fn clear_authorization_evidence(&mut self, step_name: &str) {
        self.authorization_evidence.remove(step_name);
    }

    pub(crate) fn authorization_handoff(
        &self,
        step_name: &str,
    ) -> Option<crate::config::ensemble::AuthorizationHandoffMode> {
        self.authorization_for(step_name)
            .map(|authorization| authorization.handoff)
    }

    pub(crate) fn automatic_transition_state(
        &self,
        step_name: &str,
    ) -> Option<&AutomaticTransitionState> {
        self.automatic_transitions.get(step_name)
    }

    pub(crate) fn set_automatic_transition_pending(
        &mut self,
        step_name: &str,
        target_state: String,
        expected_state: String,
    ) {
        self.automatic_transitions.insert(
            step_name.to_string(),
            AutomaticTransitionState::Pending {
                target_state,
                expected_state,
            },
        );
    }

    pub(crate) fn set_automatic_transition_applied(
        &mut self,
        step_name: &str,
        target_state: String,
    ) {
        self.automatic_transitions.insert(
            step_name.to_string(),
            AutomaticTransitionState::Applied { target_state },
        );
    }

    pub(crate) fn restore_automatic_transition_state(
        &mut self,
        step_name: &str,
        previous: Option<AutomaticTransitionState>,
    ) {
        if let Some(previous) = previous {
            self.automatic_transitions
                .insert(step_name.to_string(), previous);
        } else {
            self.automatic_transitions.remove(step_name);
        }
    }

    pub(crate) fn record_artifact_snapshot(&mut self, step_name: &str, snapshot: ArtifactSnapshot) {
        self.artifact_snapshots
            .insert(step_name.to_string(), snapshot);
    }

    pub(crate) fn record_artifact_integrity_violations(
        &mut self,
        violations: impl IntoIterator<Item = ArtifactIntegrityViolation>,
    ) {
        self.artifact_integrity_violations.extend(violations);
    }

    pub(crate) fn record_artifact_access_evidence(
        &mut self,
        evidence: ArtifactAccessEvidence,
    ) -> Option<ArtifactAccessEvidence> {
        if let Some(existing) = self
            .artifact_access_evidence
            .iter_mut()
            .find(|existing| existing.consumer_step == evidence.consumer_step)
        {
            return Some(std::mem::replace(existing, evidence));
        }
        self.artifact_access_evidence.push(evidence);
        None
    }

    pub(crate) fn restore_artifact_access_evidence(
        &mut self,
        evidence: &ArtifactAccessEvidence,
        previous: Option<ArtifactAccessEvidence>,
    ) {
        if let Some(index) = self
            .artifact_access_evidence
            .iter()
            .position(|current| current == evidence)
        {
            if let Some(previous) = previous {
                self.artifact_access_evidence[index] = previous;
            } else {
                self.artifact_access_evidence.remove(index);
            }
        }
    }

    /// Marks an immutable consumer launch as durably committed. The marker is
    /// authority to release the worker gate, not evidence that the child ran.
    pub(crate) fn mark_immutable_consumer_launch_committed(&mut self, step_name: &str) {
        self.launched_immutable_consumers
            .insert(step_name.to_string());
    }

    pub(crate) fn clear_immutable_consumer_launch_commitment(&mut self, step_name: &str) {
        self.launched_immutable_consumers.remove(step_name);
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
            artifact_snapshots: snapshot.artifact_snapshots,
            authorization_evidence: snapshot.authorization_evidence,
            automatic_transitions: snapshot.automatic_transitions,
            artifact_integrity_violations: snapshot
                .artifact_integrity_evidence
                .artifact_integrity_violations,
            artifact_access_evidence: snapshot
                .artifact_integrity_evidence
                .artifact_access_evidence,
            launched_immutable_consumers: snapshot.launched_immutable_consumers,
            gate_evidence: *snapshot.gate_evidence,
            route_decisions: snapshot.route_decisions,
            acceptance_attempts: snapshot.acceptance_attempts,
            resolved_acceptance_plan: snapshot.resolved_acceptance_plan,
            dag: StepDag {
                steps: snapshot.dag_steps,
            },
            synthetic_fixup_steps: snapshot.synthetic_fixup_steps,
            ownership_lease: snapshot.ownership_lease,
            workspace_branch_name: snapshot.workspace_branch_name,
            selected_workflow: snapshot.selected_workflow,
            active_scheduler_reservations: snapshot.active_scheduler_reservations,
        })
    }

    /// Records opaque adapter ownership alongside the durable pipeline snapshot.
    pub(crate) fn set_ownership_lease(&mut self, lease: OwnershipLease) {
        self.ownership_lease = Some(lease);
    }

    pub(crate) fn workspace_branch_name(&self) -> Option<&str> {
        self.workspace_branch_name.as_deref().or_else(|| {
            self.ownership_lease
                .as_ref()
                .and_then(|lease| lease.branch_name.as_deref())
        })
    }

    pub(crate) fn set_workspace_branch_name(&mut self, branch_name: String) {
        self.workspace_branch_name = Some(branch_name);
    }

    pub(crate) fn ownership_lease(&self) -> Option<&OwnershipLease> {
        self.ownership_lease.as_ref()
    }

    pub(crate) fn set_selected_workflow(&mut self, selected: SelectedWorkflowSnapshot) {
        self.selected_workflow = Some(selected);
    }

    pub(crate) fn selected_workflow(&self) -> Option<&SelectedWorkflowSnapshot> {
        self.selected_workflow.as_ref()
    }

    pub fn normalize_stale_running_steps(&mut self) {
        let stale_steps = self
            .step_states
            .iter()
            .filter_map(|(step_name, state)| {
                matches!(state, StepState::Running { .. }).then_some(step_name.clone())
            })
            .collect::<std::collections::HashSet<_>>();
        let provisional_steps = stale_steps
            .iter()
            .filter(|step_name| !self.launched_immutable_consumers.contains(*step_name))
            .collect::<std::collections::HashSet<_>>();
        for step_name in &stale_steps {
            self.step_states
                .insert(step_name.clone(), StepState::Pending);
        }
        if !stale_steps.is_empty() {
            self.artifact_access_evidence
                .retain(|evidence| !provisional_steps.contains(&evidence.consumer_step));
            self.launched_immutable_consumers
                .retain(|step_name| !stale_steps.contains(step_name));
            self.active_scheduler_reservations.clear();
        }
    }

    /// Compute the initial dispatch action — all root steps (no dependencies)
    /// are ready to run immediately.
    pub fn start(&mut self) -> PipelineAction {
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
        self.clear_active_scheduler_reservation(step_name);
        self.clear_immutable_consumer_launch_commitment(step_name);
        let result = output.result.clone();
        self.step_outputs.insert(step_name.to_string(), output);
        match result {
            StepResult::Succeeded | StepResult::Concern { .. } => {
                match self.gate_check(step_name, approval_requested) {
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
    pub fn approve_gate(&mut self, step_name: &str, reason: Option<String>) -> PipelineAction {
        if !matches!(
            self.step_states.get(step_name),
            Some(StepState::AwaitingApproval { .. })
        ) {
            return PipelineAction::Waiting;
        }

        self.record_gate_human_resolution(step_name, GateHumanDecision::Approved, reason);

        self.step_states
            .insert(step_name.to_string(), StepState::Passed);
        if self.all_passed() {
            PipelineAction::Succeeded
        } else {
            self.find_dispatchable()
        }
    }

    /// Mark an approval gate as failed, halting the pipeline.
    pub fn reject_gate(
        &mut self,
        step_name: &str,
        reason: String,
        resolution_reason: Option<String>,
    ) -> PipelineAction {
        if !matches!(
            self.step_states.get(step_name),
            Some(StepState::AwaitingApproval { .. })
        ) {
            return PipelineAction::Waiting;
        }

        self.record_gate_human_resolution(
            step_name,
            GateHumanDecision::Rejected,
            resolution_reason,
        );

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

    fn record_gate_human_resolution(
        &mut self,
        step_name: &str,
        decision: GateHumanDecision,
        reason: Option<String>,
    ) {
        let Some(evidence) = self.gate_evidence.get_mut(step_name) else {
            return;
        };
        if evidence.human_resolution.is_none() {
            evidence.human_resolution = Some(GateHumanResolution { decision, reason });
        }
    }

    /// Handle a step that is blocked waiting for a human interaction response.
    pub fn step_blocked_on_human(
        &mut self,
        step_name: &str,
        interaction_request_id: String,
    ) -> PipelineAction {
        self.clear_immutable_consumer_launch_commitment(step_name);
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
        self.clear_immutable_consumer_launch_commitment(step_name);
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
        let reset_gates = self
            .dag
            .steps
            .iter()
            .filter(|step| step.kind == StepKind::Gate && reset_steps.contains(step.name.as_str()))
            .map(|step| step.name.clone())
            .collect::<Vec<_>>();
        for step in &reset_steps {
            self.step_states.insert(step.clone(), StepState::Pending);
            self.step_outputs.remove(step);
            self.artifact_snapshots.remove(step);
            self.authorization_evidence.remove(step);
            self.automatic_transitions.remove(step);
            self.clear_immutable_consumer_launch_commitment(step);
        }
        self.route_decisions.retain(|route, decision| {
            !reset_steps.contains(route) && !reset_steps.contains(&decision.source_step)
        });
        for gate in reset_gates {
            self.gate_evidence.remove(&gate);
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
                        resource_requests: Default::default(),
                        affected_paths: None,
                        output_schema: None,
                        artifact_snapshot: None,
                        artifact_inputs: Vec::new(),
                        artifact_access: Default::default(),
                        gate: None,
                        authorization: None,
                        route: None,
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

    /// Returns `true` when every step reached a successful terminal state.
    fn all_passed(&self) -> bool {
        self.dag.steps.iter().all(|s| {
            matches!(
                self.step_states.get(&s.name),
                Some(StepState::Passed | StepState::Skipped { .. })
            )
        })
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
            .map(|(name, output)| {
                (
                    name.clone(),
                    template_entry(name, output, self.artifact_snapshots.get(name).cloned()),
                )
            })
            .collect();
        let dependency_outputs = step
            .depends
            .iter()
            .filter_map(|dep| {
                self.step_outputs.get(dep).map(|output| {
                    template_entry(dep, output, self.artifact_snapshots.get(dep).cloned())
                })
            })
            .collect();

        Some(StepOutputTemplateContext {
            steps,
            dependency_outputs,
            output_schema: step.output_schema.clone(),
        })
    }

    /// Find all steps whose dependencies have settled. A shared join can run
    /// with any passed predecessor; all-skipped work is derived as skipped.
    ///
    /// Returns [`PipelineAction::Dispatch`] with the ready steps, or
    /// [`PipelineAction::Waiting`] if nothing is currently dispatchable.
    fn find_dispatchable(&mut self) -> PipelineAction {
        loop {
            self.propagate_skipped();
            let ready_route = self.dag.steps.iter().find(|step| {
                step.kind == StepKind::Route
                    && self.step_states.get(&step.name) == Some(&StepState::Pending)
                    && step.depends.iter().all(|dependency| {
                        self.step_states.get(dependency) == Some(&StepState::Passed)
                    })
            });
            if let Some(step) = ready_route.cloned() {
                if let Err(reason) = self.evaluate_route(&step) {
                    self.step_states.insert(
                        step.name.clone(),
                        StepState::Failed {
                            summary: reason.clone(),
                        },
                    );
                    return PipelineAction::Failed {
                        step: step.name,
                        reason,
                    };
                }
                continue;
            }
            let ready_gate = self.dag.steps.iter().find(|step| {
                step.kind == StepKind::Gate
                    && self.step_states.get(&step.name) == Some(&StepState::Pending)
                    && (step.depends.is_empty()
                        || (step.depends.iter().all(|dependency| {
                            matches!(
                                self.step_states.get(dependency),
                                Some(StepState::Passed | StepState::Skipped { .. })
                            )
                        }) && step.depends.iter().any(|dependency| {
                            self.step_states.get(dependency) == Some(&StepState::Passed)
                        })))
            });
            let Some(step) = ready_gate.cloned() else {
                break;
            };
            let Some(config) = step.gate else {
                let reason = format!(
                    "gate step '{}' has no resolved gate configuration",
                    step.name
                );
                self.step_states.insert(
                    step.name.clone(),
                    StepState::Errored {
                        error: reason.clone(),
                    },
                );
                return PipelineAction::Failed {
                    step: step.name,
                    reason,
                };
            };
            let outputs = config
                .assessment_steps
                .iter()
                .chain(std::iter::once(&config.adjudication_step))
                .filter_map(|source| {
                    self.step_outputs
                        .get(source)
                        .cloned()
                        .map(|output| (source.clone(), output))
                })
                .collect::<BTreeMap<_, _>>();
            let evidence = match evaluate_gate(
                &config.assessment_steps,
                &config.adjudication_step,
                &outputs,
            ) {
                Ok(evidence) => evidence,
                Err(reason) => {
                    self.step_states.insert(
                        step.name.clone(),
                        StepState::Failed {
                            summary: reason.clone(),
                        },
                    );
                    return PipelineAction::Failed {
                        step: step.name,
                        reason,
                    };
                }
            };
            let outcome = evidence.outcome;
            self.gate_evidence.insert(step.name.clone(), evidence);
            match outcome {
                GateOutcome::Passed => {
                    self.step_states.insert(step.name, StepState::Passed);
                }
                GateOutcome::Failed => {
                    let reason = "gate upheld a blocking finding".to_string();
                    self.step_states.insert(
                        step.name.clone(),
                        StepState::Failed {
                            summary: reason.clone(),
                        },
                    );
                    return PipelineAction::Failed {
                        step: step.name,
                        reason,
                    };
                }
                GateOutcome::AwaitingHuman => {
                    self.step_states.insert(
                        step.name.clone(),
                        StepState::AwaitingApproval {
                            interaction_request_id: None,
                        },
                    );
                    return PipelineAction::AwaitingApproval {
                        step: step.name,
                        approval_state: None,
                    };
                }
            }
        }

        if self.all_passed() {
            return PipelineAction::Succeeded;
        }

        let requests: Vec<DispatchRequest> = self
            .dag
            .steps
            .iter()
            .filter(|s| {
                s.kind.requires_agent()
                    && self.step_states.get(&s.name) == Some(&StepState::Pending)
                    && (s.depends.is_empty()
                        || (s.depends.iter().all(|dependency| {
                            matches!(
                                self.step_states.get(dependency),
                                Some(StepState::Passed | StepState::Skipped { .. })
                            )
                        }) && s.depends.iter().any(|dependency| {
                            self.step_states.get(dependency) == Some(&StepState::Passed)
                        })))
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

    fn evaluate_route(&mut self, step: &DagStep) -> Result<(), String> {
        let config = step.route.as_ref().ok_or_else(|| {
            format!(
                "route step '{}' has no resolved route configuration",
                step.name
            )
        })?;
        if let Some(existing) = self.route_decisions.get(&step.name).cloned() {
            self.step_states
                .insert(step.name.clone(), StepState::Passed);
            self.skip_unselected_route_successors(step, &existing)?;
            return Ok(());
        }
        let source = self
            .step_outputs
            .get(&config.source.step)
            .and_then(|output| output.output.as_ref())
            .ok_or_else(|| format!("route step '{}' source output is missing", step.name))?;
        let selected_case = source
            .pointer(&config.source.pointer)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "route step '{}' source pointer did not resolve to a string",
                    step.name
                )
            })?
            .to_string();
        if !config.cases.contains_key(&selected_case) {
            return Err(format!(
                "route step '{}' has no case for source value '{selected_case}'",
                step.name
            ));
        }
        let bytes = serde_json::to_vec(source).map_err(|error| {
            format!(
                "route step '{}' could not serialize source evidence: {error}",
                step.name
            )
        })?;
        let decision = RouteDecisionEvidence {
            source_step: config.source.step.clone(),
            pointer: config.source.pointer.clone(),
            selected_case,
            source_output_digest: format!("{:x}", Sha256::digest(bytes)),
        };
        self.route_decisions
            .insert(step.name.clone(), decision.clone());
        self.step_states
            .insert(step.name.clone(), StepState::Passed);
        self.skip_unselected_route_successors(step, &decision)
    }

    fn skip_unselected_route_successors(
        &mut self,
        step: &DagStep,
        decision: &RouteDecisionEvidence,
    ) -> Result<(), String> {
        let config: &RouteConfig = step.route.as_ref().ok_or_else(|| {
            format!(
                "route step '{}' has no resolved route configuration",
                step.name
            )
        })?;
        let selected = config
            .cases
            .get(&decision.selected_case)
            .ok_or_else(|| format!("route step '{}' has no selected case", step.name))?;
        let provenance = RouteSkipProvenance {
            route_step: step.name.clone(),
            source_step: decision.source_step.clone(),
            selected_case: decision.selected_case.clone(),
        };
        let successors = self
            .dag
            .steps
            .iter()
            .filter(|candidate| candidate.depends.contains(&step.name))
            .map(|candidate| candidate.name.clone())
            .collect::<Vec<_>>();
        for successor in successors {
            if !selected.contains(&successor)
                && self.step_states.get(&successor) == Some(&StepState::Pending)
            {
                self.step_states.insert(
                    successor,
                    StepState::Skipped {
                        provenance: vec![provenance.clone()],
                    },
                );
            }
        }
        Ok(())
    }

    fn propagate_skipped(&mut self) {
        loop {
            let pending = self
                .dag
                .steps
                .iter()
                .filter(|step| {
                    self.step_states.get(&step.name) == Some(&StepState::Pending)
                        && !step.depends.is_empty()
                        && step.depends.iter().all(|dependency| {
                            matches!(
                                self.step_states.get(dependency),
                                Some(StepState::Skipped { .. })
                            )
                        })
                })
                .map(|step| step.name.clone())
                .collect::<Vec<_>>();
            if pending.is_empty() {
                break;
            }
            for step_name in pending {
                let provenance = self
                    .dag
                    .steps
                    .iter()
                    .find(|step| step.name == step_name)
                    .into_iter()
                    .flat_map(|step| step.depends.iter())
                    .filter_map(|dependency| match self.step_states.get(dependency) {
                        Some(StepState::Skipped { provenance }) => Some(provenance.clone()),
                        _ => None,
                    })
                    .flatten()
                    .collect();
                self.step_states
                    .insert(step_name, StepState::Skipped { provenance });
            }
        }
    }
}

fn validate_snapshot(snapshot: &PipelineRunSnapshot) -> Result<(), crate::error::PipelineError> {
    if snapshot.selected_workflow.as_ref().is_some_and(|selected| {
        selected.rule.trim().is_empty()
            || selected.pipeline.trim().is_empty()
            || selected.lane.trim().is_empty()
    }) {
        return Err(crate::error::PipelineError::InvalidSnapshot {
            reason: "selected workflow rule, pipeline, and lane must be non-blank".to_string(),
        });
    }
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

fn template_entry(
    step: &str,
    output: &StepOutput,
    artifact_snapshot: Option<ArtifactSnapshot>,
) -> StepOutputTemplateEntry {
    StepOutputTemplateEntry {
        step: step.to_string(),
        result: match &output.result {
            StepResult::Succeeded => "succeeded".to_string(),
            StepResult::Concern { .. } => "concern".to_string(),
            StepResult::Failed { .. } => "failed".to_string(),
        },
        summary: output.summary.clone(),
        output: output.output.clone(),
        artifact_snapshot,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::{
        ArtifactAccessEnforcement, ArtifactRepositoryObservation, ArtifactSnapshot,
    };
    use crate::config::ensemble::{
        ArtifactSnapshotConfig, AuthorizationHandoffMode, GateConfig, OnFailure,
        OutputSchemaConfig, RouteConfig, RouteSource, StepApprovalConfig, StepApprovalMode,
        StepAuthorizationConfig, StepConfig, StepKind, TrackerEventPredicateConfig,
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

    fn assessment_gate() -> StepConfig {
        StepConfig {
            name: "gate".to_string(),
            kind: StepKind::Gate,
            agent: String::new(),
            depends: Some(vec!["adjudicate".to_string()]),
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
            gate: Some(GateConfig {
                assessment_steps: vec!["review".to_string()],
                adjudication_step: "adjudicate".to_string(),
            }),
            authorization: None,
            route: None,
        }
    }

    fn assessment_output() -> StepOutput {
        StepOutput {
            result: StepResult::Succeeded,
            summary: None,
            output: Some(json!({"assessment": {"findings": [{
                "id": "finding-1", "severity": "blocking", "summary": "A finding",
                "evidence": {"source": "test"}
            }]}})),
        }
    }

    fn adjudication_output(disposition: &str) -> StepOutput {
        StepOutput {
            result: StepResult::Succeeded,
            summary: None,
            output: Some(json!({"adjudication": {"dispositions": [{
                "source_step": "review", "finding_id": "finding-1", "disposition": disposition,
                "rationale": "Checked", "evidence": {"source": "test"}
            }]}})),
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
    fn producer_snapshot_and_schema_survive_restart_for_downstream_context() {
        let mut build = test_step("build", "builder", Some(vec![]));
        build.output_schema = Some(OutputSchemaConfig {
            path: "schemas/build.json".into(),
            schema: Some(json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "required": ["artifact"]
            })),
        });
        build.artifact_snapshot = Some(ArtifactSnapshotConfig {
            repositories: vec!["app".to_string()],
        });
        let steps = vec![
            build,
            test_step("review", "reviewer", Some(vec!["build".to_string()])),
        ];
        let mut run = PipelineRun::new("issue-1".to_string(), 2, build_dag(&steps).unwrap());
        run.record_artifact_snapshot(
            "build",
            ArtifactSnapshot {
                identity: "snapshot-1".to_string(),
                run_id: "run-1".to_string(),
                cycle: 2,
                producer_step: "build".to_string(),
                attempt: 1,
                output_digest: "output-1".to_string(),
                captured_at: None,
                repositories: vec![ArtifactRepositoryObservation {
                    repository: "app".to_string(),
                    head: "abc123".to_string(),
                    index_digest: "index-1".to_string(),
                    tracked_index_entries: std::collections::BTreeMap::new(),
                    tracked_worktree_digest: "worktree-1".to_string(),
                    tracked_paths: Vec::new(),
                    tracked_path_digests: std::collections::BTreeMap::new(),
                    untracked_paths: vec!["report.json".to_string()],
                    untracked_digest: "untracked-1".to_string(),
                    untracked_path_digests: std::collections::BTreeMap::new(),
                }],
            },
        );
        run.step_completed(
            "build",
            StepOutput {
                result: StepResult::Succeeded,
                summary: Some("built".to_string()),
                output: Some(json!({"artifact": "branch"})),
            },
            false,
        );

        let encoded = serde_json::to_string(&run.to_snapshot()).unwrap();
        let restored = PipelineRun::from_snapshot(serde_json::from_str(&encoded).unwrap()).unwrap();
        let build_context = restored.output_context_for("build").unwrap();
        let review_context = restored.output_context_for("review").unwrap();

        assert_eq!(
            build_context.output_schema.unwrap().schema["required"],
            json!(["artifact"])
        );
        assert_eq!(
            review_context.dependency_outputs[0]
                .artifact_snapshot
                .as_ref()
                .map(|snapshot| snapshot.identity.as_str()),
            Some("snapshot-1")
        );
        assert_eq!(
            review_context.dependency_outputs[0]
                .artifact_snapshot
                .as_ref()
                .map(|snapshot| (snapshot.run_id.as_str(), snapshot.cycle)),
            Some(("run-1", 2))
        );
    }

    #[test]
    fn pipeline_run_snapshot_preserves_opaque_ownership_lease() {
        let dag = crate::pipeline::dag::build_dag(&[test_step("build", "builder", Some(vec![]))])
            .unwrap();
        let mut run = PipelineRun::new("issue-1".to_string(), 1, dag);
        run.set_ownership_lease(OwnershipLease {
            id: "adapter-lease-1".to_string(),
            branch_name: Some("ensemble/issue-1".to_string()),
        });
        run.set_workspace_branch_name("configured/issue-1".to_string());
        run.set_selected_workflow(SelectedWorkflowSnapshot {
            rule: "ready".to_string(),
            pipeline: "delivery".to_string(),
            lane: "delivery".to_string(),
        });

        let snapshot = run.to_snapshot();
        assert_eq!(
            snapshot.ownership_lease,
            Some(OwnershipLease {
                id: "adapter-lease-1".to_string(),
                branch_name: Some("ensemble/issue-1".to_string()),
            })
        );
        let restored = PipelineRun::from_snapshot(snapshot).unwrap();
        assert_eq!(restored.workspace_branch_name(), Some("configured/issue-1"));
        assert_eq!(
            restored.selected_workflow(),
            Some(&SelectedWorkflowSnapshot {
                rule: "ready".to_string(),
                pipeline: "delivery".to_string(),
                lane: "delivery".to_string(),
            })
        );
    }

    #[test]
    fn stale_running_snapshot_releases_durable_scheduler_reservation() {
        let mut run = make_run(&[make_step("build", "builder", &[])]);
        run.set_active_scheduler_reservation(
            "build",
            SchedulerReservation {
                resources: std::collections::BTreeMap::from([("database".to_string(), 1)]),
                paths: vec![crate::orchestrator::resources::NormalizedPath {
                    repository: "app".to_string(),
                    path: "src/main.rs".to_string(),
                }],
            },
        );
        run.mark_running("build", "session".to_string());

        let mut restored = PipelineRun::from_snapshot(run.to_snapshot()).unwrap();
        restored.normalize_stale_running_steps();

        assert!(restored.active_scheduler_reservations.is_empty());
        assert_eq!(restored.step_states["build"], StepState::Pending);
    }

    #[test]
    fn stale_running_snapshot_discards_only_the_stale_consumer_evidence() {
        let mut run = make_run(&[
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &["build"]),
        ]);
        run.record_artifact_access_evidence(ArtifactAccessEvidence {
            consumer_step: "build".to_string(),
            enforcement: ArtifactAccessEnforcement::DirectAcpUnsupported,
        });
        run.record_artifact_access_evidence(ArtifactAccessEvidence {
            consumer_step: "review".to_string(),
            enforcement: ArtifactAccessEnforcement::AcpxApproveReads,
        });
        run.mark_running("review", "session-review".to_string());

        run.normalize_stale_running_steps();

        assert_eq!(
            run.artifact_access_evidence,
            vec![ArtifactAccessEvidence {
                consumer_step: "build".to_string(),
                enforcement: ArtifactAccessEnforcement::DirectAcpUnsupported,
            }]
        );
        run.record_artifact_access_evidence(ArtifactAccessEvidence {
            consumer_step: "review".to_string(),
            enforcement: ArtifactAccessEnforcement::AcpxDenyAll,
        });
        assert_eq!(
            run.artifact_access_evidence,
            vec![
                ArtifactAccessEvidence {
                    consumer_step: "build".to_string(),
                    enforcement: ArtifactAccessEnforcement::DirectAcpUnsupported,
                },
                ArtifactAccessEvidence {
                    consumer_step: "review".to_string(),
                    enforcement: ArtifactAccessEnforcement::AcpxDenyAll,
                },
            ]
        );
    }

    #[test]
    fn stale_running_snapshot_retains_durably_committed_consumer_evidence() {
        let mut run = make_run(&[make_step("review", "reviewer", &[])]);
        run.record_artifact_access_evidence(ArtifactAccessEvidence {
            consumer_step: "review".to_string(),
            enforcement: ArtifactAccessEnforcement::AcpxApproveReads,
        });
        run.mark_running("review", "session-review".to_string());
        run.mark_immutable_consumer_launch_committed("review");

        let mut restored = PipelineRun::from_snapshot(run.to_snapshot()).unwrap();
        restored.normalize_stale_running_steps();

        assert_eq!(restored.step_states["review"], StepState::Pending);
        assert_eq!(restored.artifact_access_evidence.len(), 1);
        assert!(restored.launched_immutable_consumers.is_empty());
    }

    #[test]
    fn completing_one_parallel_step_keeps_the_other_durable_reservation() {
        let mut run = make_run(&[
            make_step("left", "builder", &[]),
            make_step("right", "builder", &[]),
        ]);
        run.set_active_scheduler_reservation("left", SchedulerReservation::default());
        run.set_active_scheduler_reservation(
            "right",
            SchedulerReservation {
                resources: std::collections::BTreeMap::from([("database".to_string(), 1)]),
                paths: vec![],
            },
        );
        run.mark_running("left", "left-session".to_string());
        run.mark_running("right", "right-session".to_string());

        run.step_completed("left", approve_output(), false);

        assert!(!run.active_scheduler_reservations.contains_key("left"));
        assert!(run.active_scheduler_reservations.contains_key("right"));
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
        let mut run = make_run(&steps);

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
    fn failed_parallel_predecessor_does_not_dispatch_a_shared_join() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review-a", "reviewer", &["build"]),
            make_step("review-b", "reviewer", &["build"]),
            make_step("synthesize", "synthesizer", &["review-a", "review-b"]),
        ];
        let mut run = make_run(&steps);

        run.mark_running("build", "session-build".to_string());
        assert!(matches!(
            run.step_completed("build", approve_output(), false),
            PipelineAction::Dispatch(_)
        ));
        run.mark_running("review-a", "session-a".to_string());
        run.mark_running("review-b", "session-b".to_string());

        assert!(matches!(
            run.step_completed("review-a", failed_output("review failed"), false),
            PipelineAction::Failed { .. }
        ));
        let action = run.step_completed("review-b", approve_output(), false);

        assert_eq!(action, PipelineAction::Waiting);
        assert_eq!(run.step_states["synthesize"], StepState::Pending);
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

        let action = run.approve_gate("implement", None);
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

        let action = run.approve_gate("implement", None);
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

        let action = run.reject_gate("review", "needs more work".to_string(), None);
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
    fn concern_with_unconfigured_approval_request_fails_like_success() {
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

        assert!(matches!(action, PipelineAction::Failed { ref step, .. } if step == "review"));
        assert!(matches!(
            run.step_states["review"],
            StepState::Errored { .. }
        ));
    }

    #[test]
    fn concern_result_on_always_approval_step_waits_for_approval() {
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

        assert_eq!(
            action,
            PipelineAction::AwaitingApproval {
                step: "review".to_string(),
                approval_state: Some("Review gate".to_string()),
            }
        );
        assert!(matches!(
            run.step_states["review"],
            StepState::AwaitingApproval { .. }
        ));
    }

    #[test]
    fn concern_result_on_terminal_always_approval_step_waits_for_approval() {
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

        assert_eq!(
            action,
            PipelineAction::AwaitingApproval {
                step: "review".to_string(),
                approval_state: Some("Review gate".to_string()),
            }
        );
        assert!(matches!(
            run.step_states["review"],
            StepState::AwaitingApproval { .. }
        ));
    }

    #[test]
    fn ready_gate_passes_without_dispatching_an_agent() {
        let steps = vec![
            make_step("review", "reviewer", &[]),
            StepConfig {
                kind: StepKind::Synthesis,
                depends: Some(vec!["review".to_string()]),
                name: "adjudicate".to_string(),
                agent: "synthesizer".to_string(),
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
            assessment_gate(),
            make_step("publish", "publisher", &["gate"]),
        ];
        let mut run = make_run(&steps);

        assert!(matches!(run.start(), PipelineAction::Dispatch(_)));
        let action = run.step_completed("review", assessment_output(), false);
        assert!(
            matches!(&action, PipelineAction::Dispatch(requests) if requests[0].step_name == "adjudicate")
        );
        let action = run.step_completed("adjudicate", adjudication_output("dismissed"), false);

        assert!(
            matches!(&action, PipelineAction::Dispatch(requests) if requests.len() == 1 && requests[0].step_name == "publish")
        );
        assert_eq!(run.step_states["gate"], StepState::Passed);
        assert!(run.gate_evidence.contains_key("gate"));
    }

    #[test]
    fn retry_from_step_clears_evidence_for_reset_gates() {
        let steps = vec![
            make_step("review", "reviewer", &[]),
            StepConfig {
                kind: StepKind::Synthesis,
                depends: Some(vec!["review".to_string()]),
                name: "adjudicate".to_string(),
                agent: "synthesizer".to_string(),
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
            assessment_gate(),
        ];
        let mut run = make_run(&steps);

        assert!(matches!(run.start(), PipelineAction::Dispatch(_)));
        let _ = run.step_completed("review", assessment_output(), false);
        let _ = run.step_completed("adjudicate", adjudication_output("dismissed"), false);
        assert!(run.gate_evidence.contains_key("gate"));

        run.retry_from_step("review");

        assert!(!run.gate_evidence.contains_key("gate"));
    }

    #[test]
    fn ready_gate_blocks_once_or_fails_from_structured_evidence() {
        let steps = vec![
            make_step("review", "reviewer", &[]),
            StepConfig {
                kind: StepKind::Synthesis,
                depends: Some(vec!["review".to_string()]),
                name: "adjudicate".to_string(),
                agent: "synthesizer".to_string(),
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
            assessment_gate(),
        ];
        let mut unresolved = make_run(&steps);
        unresolved.start();
        unresolved.step_completed("review", assessment_output(), false);
        let action =
            unresolved.step_completed("adjudicate", adjudication_output("unresolved"), false);
        assert!(
            matches!(action, PipelineAction::AwaitingApproval { ref step, .. } if step == "gate")
        );
        assert!(matches!(
            unresolved.step_states["gate"],
            StepState::AwaitingApproval { .. }
        ));
        assert_eq!(
            unresolved.approve_gate(
                "gate",
                Some("operator accepted the residual risk".to_string())
            ),
            PipelineAction::Succeeded
        );
        let evidence = unresolved.gate_evidence.get("gate").unwrap();
        assert_eq!(evidence.outcome, GateOutcome::AwaitingHuman);
        assert_eq!(
            evidence.human_resolution,
            Some(crate::pipeline::assessment::GateHumanResolution {
                decision: crate::pipeline::assessment::GateHumanDecision::Approved,
                reason: Some("operator accepted the residual risk".to_string()),
            })
        );

        let mut blocking = make_run(&steps);
        blocking.start();
        blocking.step_completed("review", assessment_output(), false);
        let action = blocking.step_completed("adjudicate", adjudication_output("upheld"), false);
        assert!(matches!(action, PipelineAction::Failed { ref step, .. } if step == "gate"));
        assert!(matches!(
            blocking.step_states["gate"],
            StepState::Failed { .. }
        ));
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
    fn retry_from_step_clears_artifact_snapshots_for_reset_producers() {
        let steps = vec![
            make_step("build", "builder", &[]),
            make_step("review", "reviewer", &["build"]),
        ];
        let mut run = make_run(&steps);
        for producer_step in ["build", "review"] {
            run.record_artifact_snapshot(
                producer_step,
                ArtifactSnapshot {
                    identity: format!("snapshot-{producer_step}"),
                    run_id: "run-1".to_string(),
                    cycle: 1,
                    producer_step: producer_step.to_string(),
                    attempt: 1,
                    output_digest: format!("output-{producer_step}"),
                    captured_at: None,
                    repositories: Vec::new(),
                },
            );
        }

        run.retry_from_step("build");

        assert!(run.artifact_snapshots.is_empty());
        run.record_artifact_integrity_violations([ArtifactIntegrityViolation {
            consumer_step: "review".to_string(),
            producer_step: "build".to_string(),
            artifact_identity: "artifact-1".to_string(),
            repository: "repo".to_string(),
            expected_digest: "expected".to_string(),
            observed_digest: "observed".to_string(),
            changed_paths: vec!["src/lib.rs".to_string()],
            omitted_changed_path_count: 0,
        }]);
        run.retry_from_step("build");
        assert_eq!(run.artifact_integrity_violations.len(), 1);
    }

    #[test]
    fn immutable_artifact_violations_survive_snapshot_restore() {
        let mut run = make_run(&[make_step("review", "reviewer", &[])]);
        run.record_artifact_integrity_violations([ArtifactIntegrityViolation {
            consumer_step: "review".to_string(),
            producer_step: "build".to_string(),
            artifact_identity: "artifact-1".to_string(),
            repository: "repo".to_string(),
            expected_digest: "expected".to_string(),
            observed_digest: "observed".to_string(),
            changed_paths: vec!["src/lib.rs".to_string()],
            omitted_changed_path_count: 0,
        }]);

        let restored = PipelineRun::from_snapshot(run.to_snapshot()).unwrap();

        assert_eq!(restored.artifact_integrity_violations.len(), 1);
        assert_eq!(
            restored.artifact_integrity_violations[0].artifact_identity,
            "artifact-1"
        );
    }

    #[test]
    fn immutable_artifact_access_enforcement_survives_snapshot_restore() {
        let mut run = make_run(&[make_step("review", "reviewer", &[])]);
        run.record_artifact_access_evidence(ArtifactAccessEvidence {
            consumer_step: "review".to_string(),
            enforcement: crate::artifact::ArtifactAccessEnforcement::DirectAcpUnsupported,
        });

        let restored = PipelineRun::from_snapshot(run.to_snapshot()).unwrap();

        assert_eq!(
            restored.artifact_access_evidence,
            vec![ArtifactAccessEvidence {
                consumer_step: "review".to_string(),
                enforcement: crate::artifact::ArtifactAccessEnforcement::DirectAcpUnsupported,
            }]
        );
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

    #[test]
    fn authorization_selects_latest_event_after_captured_artifact_and_rejects_conflicts() {
        let mut producer = make_step("produce", "builder", &[]);
        producer.artifact_snapshot = Some(ArtifactSnapshotConfig {
            repositories: vec!["repo".to_string()],
        });
        let mut protected = make_step("protected", "reviewer", &["produce"]);
        protected.authorization = Some(StepAuthorizationConfig {
            artifact_step: "produce".to_string(),
            event: TrackerEventPredicateConfig {
                field: "field".to_string(),
                value: "ready".to_string(),
                actors: vec!["actor".to_string()],
            },
            after_artifact: true,
            handoff: AuthorizationHandoffMode::WaitForEvent,
        });
        let mut run = make_run(&[producer, protected]);
        run.record_artifact_snapshot(
            "produce",
            ArtifactSnapshot {
                identity: "artifact-1".to_string(),
                run_id: "issue-1".to_string(),
                cycle: 1,
                producer_step: "produce".to_string(),
                attempt: 1,
                output_digest: "digest-1".to_string(),
                captured_at: Some("2026-08-15T10:00:00Z".parse().unwrap()),
                repositories: Vec::new(),
            },
        );
        let event = |id: &str, at: &str| TrackerEvent {
            item_id: "issue-1".to_string(),
            field_id: "field".to_string(),
            previous_value: None,
            value: "ready".to_string(),
            actor_id: "actor".to_string(),
            event_id: id.to_string(),
            occurred_at: at.parse().unwrap(),
        };

        let selected = run
            .select_authorization_evidence(
                "protected",
                &[
                    event("stale", "2026-08-15T09:59:59Z"),
                    event("later", "2026-08-15T10:01:00Z"),
                ],
            )
            .unwrap();
        assert_eq!(selected.event.event_id, "later");
        assert_eq!(selected.artifact_identity, "artifact-1");
        assert!(run
            .select_authorization_evidence(
                "protected",
                &[
                    event("duplicate", "2026-08-15T10:01:00Z"),
                    event("duplicate", "2026-08-15T10:02:00Z")
                ],
            )
            .is_none());
    }

    #[test]
    fn route_execution_selects_one_branch_skips_the_other_and_runs_the_shared_join() {
        let mut compare = make_step("compare", "comparator", &[]);
        compare.output_schema = Some(OutputSchemaConfig {
            path: "comparison.json".into(),
            schema: Some(json!({
                "type": "object",
                "required": ["decision"],
                "properties": {"decision": {"type": "string", "enum": ["agreement", "disagreement"]}}
            })),
        });
        let mut route = make_step("choose_review_path", "", &["compare"]);
        route.kind = StepKind::Route;
        route.on_failure = OnFailure::Halt;
        route.route = Some(RouteConfig {
            source: RouteSource {
                step: "compare".to_string(),
                pointer: "/decision".to_string(),
            },
            cases: BTreeMap::from([
                (
                    "agreement".to_string(),
                    vec!["accept_agreement".to_string()],
                ),
                ("disagreement".to_string(), vec!["escalate".to_string()]),
            ]),
        });
        let accept = make_step(
            "accept_agreement",
            "agreement_handler",
            &["choose_review_path"],
        );
        let escalate = make_step("escalate", "adjudicator", &["choose_review_path"]);
        let finish = make_step("finish", "finisher", &["accept_agreement", "escalate"]);
        let mut run = make_run(&[compare, route, accept, escalate, finish]);

        assert!(
            matches!(run.start(), PipelineAction::Dispatch(requests) if requests.iter().map(|request| request.step_name.as_str()).collect::<Vec<_>>() == vec!["compare"])
        );
        let action = run.step_completed(
            "compare",
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: Some(json!({"decision": "agreement"})),
            },
            false,
        );
        assert!(
            matches!(action, PipelineAction::Dispatch(requests) if requests.iter().map(|request| request.step_name.as_str()).collect::<Vec<_>>() == vec!["accept_agreement"])
        );
        assert_eq!(
            run.step_states.get("choose_review_path"),
            Some(&StepState::Passed)
        );
        assert!(
            matches!(run.step_states.get("escalate"), Some(StepState::Skipped { provenance }) if provenance[0].route_step == "choose_review_path")
        );
        assert!(run.step_outputs.get("choose_review_path").is_none());
        assert!(run.step_outputs.get("escalate").is_none());
        let restored = PipelineRun::from_snapshot(run.to_snapshot()).unwrap();
        assert_eq!(
            restored
                .route_decisions
                .get("choose_review_path")
                .map(|decision| decision.selected_case.as_str()),
            Some("agreement")
        );
        assert!(matches!(
            restored.step_states.get("escalate"),
            Some(StepState::Skipped { .. })
        ));

        let action = run.step_completed("accept_agreement", approve_output(), false);
        assert!(
            matches!(action, PipelineAction::Dispatch(requests) if requests.iter().map(|request| request.step_name.as_str()).collect::<Vec<_>>() == vec!["finish"])
        );
        assert_eq!(
            run.output_context_for("finish")
                .unwrap()
                .dependency_outputs
                .len(),
            1
        );
        assert_eq!(
            run.step_completed("finish", approve_output(), false),
            PipelineAction::Succeeded
        );
    }

    #[test]
    fn route_shared_gate_join_evaluates_after_selected_dependencies_settle() {
        let compare = make_step("compare", "comparator", &[]);
        let mut route = make_step("choose", "", &["compare"]);
        route.kind = StepKind::Route;
        route.on_failure = OnFailure::Halt;
        route.route = Some(RouteConfig {
            source: RouteSource {
                step: "compare".to_string(),
                pointer: "/decision".to_string(),
            },
            cases: BTreeMap::from([
                ("review".to_string(), vec!["review".to_string()]),
                ("skip".to_string(), vec!["skipped_branch".to_string()]),
            ]),
        });
        let review = make_step("review", "reviewer", &["choose"]);
        let mut adjudicate = make_step("adjudicate", "synthesizer", &["review"]);
        adjudicate.kind = StepKind::Synthesis;
        let skipped_branch = make_step("skipped_branch", "handler", &["choose"]);
        let mut gate = assessment_gate();
        gate.depends = Some(vec!["adjudicate".to_string(), "skipped_branch".to_string()]);
        let mut run = make_run(&[compare, route, review, adjudicate, skipped_branch, gate]);

        assert!(matches!(run.start(), PipelineAction::Dispatch(_)));
        assert!(matches!(
            run.step_completed(
                "compare",
                StepOutput {
                    result: StepResult::Succeeded,
                    summary: None,
                    output: Some(json!({"decision": "review"})),
                },
                false,
            ),
            PipelineAction::Dispatch(requests) if requests[0].step_name == "review"
        ));
        assert!(matches!(
            run.step_states.get("skipped_branch"),
            Some(StepState::Skipped { .. })
        ));
        assert!(matches!(
            run.step_completed("review", assessment_output(), false),
            PipelineAction::Dispatch(requests) if requests[0].step_name == "adjudicate"
        ));
        let action = run.step_completed("adjudicate", adjudication_output("dismissed"), false);
        assert_eq!(run.step_states.get("gate"), Some(&StepState::Passed));
        assert!(run.gate_evidence.contains_key("gate"));
        assert_eq!(action, PipelineAction::Succeeded);
    }

    #[test]
    fn route_case_with_no_unselected_successor_dispatches_its_only_entry() {
        let compare = make_step("compare", "comparator", &[]);
        let mut route = make_step("choose", "", &["compare"]);
        route.kind = StepKind::Route;
        route.on_failure = OnFailure::Halt;
        route.route = Some(RouteConfig {
            source: RouteSource {
                step: "compare".to_string(),
                pointer: "/decision".to_string(),
            },
            cases: BTreeMap::from([("agreement".to_string(), vec!["accept".to_string()])]),
        });
        let accept = make_step("accept", "handler", &["choose"]);
        let mut run = make_run(&[compare, route, accept]);

        run.start();
        let action = run.step_completed(
            "compare",
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: Some(json!({"decision": "agreement"})),
            },
            false,
        );

        assert!(
            matches!(action, PipelineAction::Dispatch(requests) if requests[0].step_name == "accept")
        );
        assert!(run
            .step_states
            .values()
            .all(|state| !matches!(state, StepState::Skipped { .. })));
    }

    #[test]
    fn nested_routes_execute_only_the_selected_agreement_escalation_path() {
        let compare = make_step("compare", "comparator", &[]);
        let mut choose_primary = make_step("choose_primary", "", &["compare"]);
        choose_primary.kind = StepKind::Route;
        choose_primary.on_failure = OnFailure::Halt;
        choose_primary.route = Some(RouteConfig {
            source: RouteSource {
                step: "compare".to_string(),
                pointer: "/decision".to_string(),
            },
            cases: BTreeMap::from([
                (
                    "agreement".to_string(),
                    vec!["review_agreement".to_string()],
                ),
                (
                    "escalation".to_string(),
                    vec!["review_escalation".to_string()],
                ),
            ]),
        });
        let review_agreement = make_step("review_agreement", "reviewer", &["choose_primary"]);
        let review_escalation = make_step("review_escalation", "reviewer", &["choose_primary"]);
        let mut choose_agreement = make_step("choose_agreement", "", &["review_agreement"]);
        choose_agreement.kind = StepKind::Route;
        choose_agreement.on_failure = OnFailure::Halt;
        choose_agreement.route = Some(RouteConfig {
            source: RouteSource {
                step: "review_agreement".to_string(),
                pointer: "/outcome".to_string(),
            },
            cases: BTreeMap::from([
                ("accept".to_string(), vec!["accept".to_string()]),
                ("escalate".to_string(), vec!["escalate".to_string()]),
            ]),
        });
        let accept = make_step("accept", "handler", &["choose_agreement"]);
        let escalate = make_step("escalate", "handler", &["choose_agreement"]);
        let mut run = make_run(&[
            compare,
            choose_primary,
            review_agreement,
            review_escalation,
            choose_agreement,
            accept,
            escalate,
        ]);

        run.start();
        let action = run.step_completed(
            "compare",
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: Some(json!({"decision": "agreement"})),
            },
            false,
        );
        assert!(
            matches!(action, PipelineAction::Dispatch(requests) if requests[0].step_name == "review_agreement")
        );
        let action = run.step_completed(
            "review_agreement",
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: Some(json!({"outcome": "accept"})),
            },
            false,
        );
        assert!(
            matches!(action, PipelineAction::Dispatch(requests) if requests[0].step_name == "accept")
        );
        assert!(matches!(
            run.step_states.get("review_escalation"),
            Some(StepState::Skipped { .. })
        ));
        assert!(matches!(
            run.step_states.get("escalate"),
            Some(StepState::Skipped { .. })
        ));
        assert_eq!(run.route_decisions.len(), 2);
    }

    #[test]
    fn retrying_a_route_source_reopens_the_route_and_its_skipped_branch() {
        let mut compare = make_step("compare", "comparator", &[]);
        compare.output_schema = Some(OutputSchemaConfig {
            path: "comparison.json".into(),
            schema: Some(json!({
                "type": "object",
                "required": ["decision"],
                "properties": {"decision": {"type": "string", "enum": ["agreement", "disagreement"]}}
            })),
        });
        let mut route = make_step("choose", "", &["compare"]);
        route.kind = StepKind::Route;
        route.on_failure = OnFailure::Halt;
        route.route = Some(RouteConfig {
            source: RouteSource {
                step: "compare".to_string(),
                pointer: "/decision".to_string(),
            },
            cases: BTreeMap::from([
                ("agreement".to_string(), vec!["accept".to_string()]),
                ("disagreement".to_string(), vec!["escalate".to_string()]),
            ]),
        });
        let accept = make_step("accept", "handler", &["choose"]);
        let escalate = make_step("escalate", "handler", &["choose"]);
        let finish = make_step("finish", "finisher", &["accept", "escalate"]);
        let mut run = make_run(&[compare, route, accept, escalate, finish]);

        run.start();
        run.step_completed(
            "compare",
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: Some(json!({"decision": "agreement"})),
            },
            false,
        );
        assert!(matches!(
            run.step_states.get("escalate"),
            Some(StepState::Skipped { .. })
        ));

        let reset = run.retry_from_step("compare");

        assert!(reset.is_superset(
            &[
                "compare".to_string(),
                "choose".to_string(),
                "accept".to_string(),
                "escalate".to_string(),
                "finish".to_string(),
            ]
            .into()
        ));
        assert!(run.route_decisions.is_empty());
        assert_eq!(run.step_states.get("choose"), Some(&StepState::Pending));
        assert_eq!(run.step_states.get("escalate"), Some(&StepState::Pending));
        assert!(matches!(
            run.start(),
            PipelineAction::Dispatch(requests) if requests[0].step_name == "compare"
        ));
    }

    #[test]
    fn unknown_route_value_fails_closed_without_dispatching_a_branch() {
        let compare = make_step("compare", "comparator", &[]);
        let mut route = make_step("choose", "", &["compare"]);
        route.kind = StepKind::Route;
        route.on_failure = OnFailure::Halt;
        route.route = Some(RouteConfig {
            source: RouteSource {
                step: "compare".to_string(),
                pointer: "/decision".to_string(),
            },
            cases: BTreeMap::from([("agreement".to_string(), vec!["accept".to_string()])]),
        });
        let accept = make_step("accept", "handler", &["choose"]);
        let mut run = make_run(&[compare, route, accept]);

        run.start();
        let action = run.step_completed(
            "compare",
            StepOutput {
                result: StepResult::Succeeded,
                summary: None,
                output: Some(json!({"decision": "disagreement"})),
            },
            false,
        );

        assert!(matches!(
            action,
            PipelineAction::Failed { step, reason }
                if step == "choose" && reason.contains("no case")
        ));
        assert!(matches!(
            run.step_states.get("choose"),
            Some(StepState::Failed { .. })
        ));
        assert_eq!(run.step_states.get("accept"), Some(&StepState::Pending));
    }
}
