pub const ORCH_TICK_STARTED: &str = "orchestrator.tick_started";
pub const ORCH_TICK_FINISHED: &str = "orchestrator.tick_finished";
pub const ISSUE_DISPATCH_STARTED: &str = "issue.dispatch_started";
pub const ISSUE_DISPATCH_SKIPPED: &str = "issue.dispatch_skipped";
pub const ISSUE_DISPATCH_COMPLETED: &str = "issue.dispatch_completed";
pub const ISSUE_RETRY_SCHEDULED: &str = "issue.retry_scheduled";
pub const ISSUE_RETRY_CANCELLED: &str = "issue.retry_cancelled";
pub const STEP_STARTED: &str = "step.started";
pub const STEP_WAITING: &str = "step.waiting";
pub const STEP_FINISHED: &str = "step.finished";
pub const TRACKER_TRANSITION_REQUESTED: &str = "tracker.transition_requested";
pub const TRACKER_TRANSITION_SUCCEEDED: &str = "tracker.transition_succeeded";
pub const TRACKER_TRANSITION_FAILED: &str = "tracker.transition_failed";
pub const WORKSPACE_PREPARE_STARTED: &str = "workspace.prepare_started";
pub const WORKSPACE_PREPARE_FINISHED: &str = "workspace.prepare_finished";
pub const WORKSPACE_PREPARE_FAILED: &str = "workspace.prepare_failed";
pub const WORKSPACE_HOOK_STARTED: &str = "workspace.hook_started";
pub const WORKSPACE_HOOK_FINISHED: &str = "workspace.hook_finished";
pub const WORKSPACE_HOOK_FAILED: &str = "workspace.hook_failed";
pub const AGENT_SESSION_STARTED: &str = "agent.session_started";
pub const AGENT_SESSION_FINISHED: &str = "agent.session_finished";
pub const AGENT_SESSION_FAILED: &str = "agent.session_failed";
pub const AGENT_MESSAGE: &str = "agent.message";

pub fn elapsed_ms(start: std::time::Instant) -> u128 {
    start.elapsed().as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_are_stable() {
        assert_eq!(ORCH_TICK_STARTED, "orchestrator.tick_started");
        assert_eq!(ISSUE_DISPATCH_STARTED, "issue.dispatch_started");
        assert_eq!(TRACKER_TRANSITION_FAILED, "tracker.transition_failed");
    }

    #[test]
    fn duration_helper_is_millis() {
        let start = std::time::Instant::now();
        let elapsed = elapsed_ms(start);
        assert!(elapsed <= 5_000);
    }
}
