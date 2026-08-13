use crate::interaction::model::{InteractionRequest, InteractionStatus};
use crate::orchestrator::state::FinalizeStatus;
use serde::Serialize;

const NOT_AVAILABLE: &str = "This action is not available for the current issue state.";
const NOT_RUNNING: &str = "This issue is not running.";
const NOT_RETRYING: &str = "This issue is not retrying.";
const NO_INTERACTION: &str = "This issue has no interaction awaiting input.";
const INTERACTION_REFRESHING: &str = "Interaction availability is refreshing.";
const INTERACTION_UNAVAILABLE: &str = "Interaction is unavailable; refresh and try again.";
const GUIDE_UNSUPPORTED: &str = "Guidance is not supported in Mission Control.";
const CLEANUP_UNSUPPORTED: &str = "Manual workspace cleanup is not supported.";

/// One server-derived Mission Control operation state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct ActionCapability {
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled_reason: Option<String>,
}

impl ActionCapability {
    pub fn enabled() -> Self {
        Self {
            enabled: true,
            disabled_reason: None,
        }
    }

    pub fn disabled(reason: impl Into<String>) -> Self {
        Self {
            enabled: false,
            disabled_reason: Some(reason.into()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn disabled_reason(&self) -> Option<&str> {
        self.disabled_reason.as_deref()
    }
}

/// Fixed set of issue-level operations that Mission Control can describe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct IssueActionCapabilities {
    inspect: ActionCapability,
    reply: ActionCapability,
    guide: ActionCapability,
    cancel: ActionCapability,
    stop: ActionCapability,
    retry: ActionCapability,
    resume: ActionCapability,
    finalize_approve: ActionCapability,
    finalize_retry: ActionCapability,
    cleanup: ActionCapability,
}

impl IssueActionCapabilities {
    pub fn for_issue(
        is_running: bool,
        is_retrying: bool,
        has_waiting_interaction: bool,
        finalize_status: Option<&FinalizeStatus>,
    ) -> Self {
        let (finalize_approve, finalize_retry) = match finalize_status {
            Some(FinalizeStatus::PendingApproval) => (
                ActionCapability::enabled(),
                ActionCapability::disabled(NOT_AVAILABLE),
            ),
            Some(FinalizeStatus::Failed) => (
                ActionCapability::disabled(NOT_AVAILABLE),
                ActionCapability::enabled(),
            ),
            _ => (
                ActionCapability::disabled(NOT_AVAILABLE),
                ActionCapability::disabled(NOT_AVAILABLE),
            ),
        };
        let interaction = if has_waiting_interaction {
            ActionCapability::disabled(INTERACTION_REFRESHING)
        } else {
            ActionCapability::disabled(NO_INTERACTION)
        };

        Self {
            inspect: ActionCapability::enabled(),
            reply: interaction.clone(),
            guide: ActionCapability::disabled(GUIDE_UNSUPPORTED),
            cancel: interaction.clone(),
            stop: if is_running {
                ActionCapability::enabled()
            } else {
                ActionCapability::disabled(NOT_RUNNING)
            },
            retry: if is_retrying {
                ActionCapability::enabled()
            } else {
                ActionCapability::disabled(NOT_RETRYING)
            },
            resume: interaction,
            finalize_approve,
            finalize_retry,
            cleanup: ActionCapability::disabled(CLEANUP_UNSUPPORTED),
        }
    }

    pub fn apply_interaction(&mut self, interaction: Option<&InteractionRequest>) {
        let Some(interaction) = interaction else {
            self.reply = ActionCapability::disabled(INTERACTION_UNAVAILABLE);
            self.cancel = ActionCapability::disabled(INTERACTION_UNAVAILABLE);
            self.resume = ActionCapability::disabled(INTERACTION_UNAVAILABLE);
            return;
        };

        match interaction.status {
            InteractionStatus::Open => {
                self.reply = ActionCapability::enabled();
                self.cancel = ActionCapability::enabled();
                self.resume =
                    ActionCapability::disabled("Resolve the interaction before resuming.");
            }
            InteractionStatus::Resolved if interaction.awaiting_resume => {
                self.reply =
                    ActionCapability::disabled("The interaction has already been resolved.");
                self.cancel =
                    ActionCapability::disabled("The interaction has already been resolved.");
                self.resume = ActionCapability::enabled();
            }
            InteractionStatus::Resolved => {
                self.reply =
                    ActionCapability::disabled("The interaction has already been resolved.");
                self.cancel =
                    ActionCapability::disabled("The interaction has already been resolved.");
                self.resume = ActionCapability::disabled(
                    "The resolved interaction is no longer awaiting resume.",
                );
            }
            InteractionStatus::Cancelled => {
                self.reply = ActionCapability::disabled("The interaction was cancelled.");
                self.cancel = ActionCapability::disabled("The interaction was cancelled.");
                self.resume = ActionCapability::disabled("The interaction was cancelled.");
            }
        }
    }

    pub fn inspect(&self) -> &ActionCapability {
        &self.inspect
    }

    pub fn reply(&self) -> &ActionCapability {
        &self.reply
    }

    pub fn guide(&self) -> &ActionCapability {
        &self.guide
    }

    pub fn cancel(&self) -> &ActionCapability {
        &self.cancel
    }

    pub fn stop(&self) -> &ActionCapability {
        &self.stop
    }

    pub fn retry(&self) -> &ActionCapability {
        &self.retry
    }

    pub fn resume(&self) -> &ActionCapability {
        &self.resume
    }

    pub fn finalize_approve(&self) -> &ActionCapability {
        &self.finalize_approve
    }

    pub fn finalize_retry(&self) -> &ActionCapability {
        &self.finalize_retry
    }

    pub fn cleanup(&self) -> &ActionCapability {
        &self.cleanup
    }
}

/// Fixed step navigation capability for Mission Control.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, utoipa::ToSchema)]
pub struct StepActionCapabilities {
    inspect: ActionCapability,
}

impl StepActionCapabilities {
    pub fn for_step(can_inspect: bool) -> Self {
        Self {
            inspect: if can_inspect {
                ActionCapability::enabled()
            } else {
                ActionCapability::disabled("No step details are available yet.")
            },
        }
    }

    pub fn inspect(&self) -> &ActionCapability {
        &self.inspect
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_capability_has_no_disabled_reason() {
        let capability = ActionCapability::enabled();

        assert!(capability.is_enabled());
        assert_eq!(capability.disabled_reason(), None);
    }

    #[test]
    fn disabled_capability_has_operator_reason() {
        let capability = ActionCapability::disabled("Unavailable now.");

        assert!(!capability.is_enabled());
        assert_eq!(capability.disabled_reason(), Some("Unavailable now."));
    }

    #[test]
    fn issue_capabilities_follow_runtime_and_finalize_state() {
        let running = IssueActionCapabilities::for_issue(true, false, false, None);
        assert!(running.inspect().is_enabled());
        assert!(running.stop().is_enabled());
        assert!(!running.retry().is_enabled());
        assert_eq!(running.retry().disabled_reason(), Some(NOT_RETRYING));

        let retrying = IssueActionCapabilities::for_issue(false, true, false, None);
        assert!(retrying.retry().is_enabled());
        assert!(!retrying.stop().is_enabled());
        assert_eq!(retrying.stop().disabled_reason(), Some(NOT_RUNNING));

        let pending_approval = IssueActionCapabilities::for_issue(
            false,
            false,
            false,
            Some(&FinalizeStatus::PendingApproval),
        );
        assert!(pending_approval.finalize_approve().is_enabled());
        assert!(!pending_approval.finalize_retry().is_enabled());

        let failed_finalize =
            IssueActionCapabilities::for_issue(false, false, false, Some(&FinalizeStatus::Failed));
        assert!(!failed_finalize.finalize_approve().is_enabled());
        assert!(failed_finalize.finalize_retry().is_enabled());
    }

    #[test]
    fn step_inspection_capability_preserves_navigation_availability() {
        assert!(StepActionCapabilities::for_step(true)
            .inspect()
            .is_enabled());
        let unavailable = StepActionCapabilities::for_step(false);
        assert!(!unavailable.inspect().is_enabled());
        assert_eq!(
            unavailable.inspect().disabled_reason(),
            Some("No step details are available yet.")
        );
    }
}
